import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import {
  ReviewJobClaimConflictError,
  ReviewJobLeaseConflictError,
} from "../domain/review-jobs/errors.ts";
import { ReviewJobStore } from "./review-job-store.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const LATER_SHA = "c".repeat(40);

function claimId(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

describe("ReviewJobStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let store: ReviewJobStore;
  let repositoryId: string;

  before(async () => {
    configureTestcontainers();
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = container.getConnectionUri();
    const migrationPool = new Pool({ connectionString });
    for (const migrationPath of [
      "../../../prisma/migrations/202607220001_initial_control_plane/migration.sql",
      "../../../prisma/migrations/202607230001_repository_inventory_access/migration.sql",
      "../../../prisma/migrations/202607280001_roadie_scope_projection/migration.sql",
      "../../../prisma/migrations/202607290001_review_evidence_and_proposals/migration.sql",
      "../../../prisma/migrations/202607310001_review_job_retry_attempts/migration.sql",
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();

    database = createDatabaseClient({ connectionString });
    store = new ReviewJobStore(database);
  });

  after(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await database.auditEvent.deleteMany();
    await database.reviewJob.deleteMany();
    await database.reviewJobClaimInvocation.deleteMany();
    await database.repositoryCursor.deleteMany();
    await database.repositoryRegistry.deleteMany();

    const repository = await database.repositoryRegistry.create({
      data: {
        githubRepositoryId: "123456",
        repositoryFullName: "example/example-service",
        defaultBranch: "main",
        defaultBranchHeadSha: HEAD_SHA,
        lastInventoryRefreshAt: new Date("2026-07-22T08:00:00.000Z"),
      },
    });
    repositoryId = repository.id;
  });

  it("enqueues one durable job for repeated delivery", async () => {
    const input = {
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL" as const,
      availableAt: new Date("2026-07-22T09:00:00.000Z"),
    };

    const [first, replay] = await Promise.all([
      store.enqueue(input),
      store.enqueue(input),
    ]);

    assert.equal(first.id, replay.id);
    assert.equal(await database.reviewJob.count(), 1);
    assert.equal(await database.auditEvent.count(), 1);
  });

  it("creates one new attempt after an incomplete review", async () => {
    const input = {
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL" as const,
      availableAt: new Date("2026-07-22T09:00:00.000Z"),
    };
    const first = await store.enqueue(input);
    await database.reviewJob.update({
      where: { id: first.id },
      data: {
        status: "COMPLETED",
        outcome: "INCOMPLETE",
        outcomeSummary: "The documentation source was unavailable.",
        completedAt: new Date("2026-07-22T09:05:00.000Z"),
        lastLeaseToken: claimId(100),
        lastLeaseOutcome: "COMPLETED",
      },
    });

    const [retry, replay] = await Promise.all([
      store.enqueue(input),
      store.enqueue(input),
    ]);

    assert.notEqual(retry.id, first.id);
    assert.equal(replay.id, retry.id);
    assert.equal(first.attemptNumber, 1);
    assert.equal(retry.attemptNumber, 2);
    assert.equal(retry.status, "PENDING");
    assert.equal(await database.reviewJob.count(), 2);
    assert.equal(await database.auditEvent.count(), 2);
  });

  it("does not retry a successfully completed review range", async () => {
    const input = {
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL" as const,
      availableAt: new Date("2026-07-22T09:00:00.000Z"),
    };
    const completed = await store.enqueue(input);
    await database.reviewJob.update({
      where: { id: completed.id },
      data: {
        status: "COMPLETED",
        outcome: "IN_SYNC",
        outcomeSummary: "The documentation is current.",
        completedAt: new Date("2026-07-22T09:05:00.000Z"),
        cursorAdvancedAt: new Date("2026-07-22T09:05:00.000Z"),
        lastLeaseToken: claimId(101),
        lastLeaseOutcome: "COMPLETED",
      },
    });

    const replay = await store.enqueue(input);

    assert.equal(replay.id, completed.id);
    assert.equal(replay.attemptNumber, 1);
    assert.equal(await database.reviewJob.count(), 1);
    assert.equal(await database.auditEvent.count(), 1);
  });

  it("rejects inconsistent cursor and lease states at the database boundary", async () => {
    await assert.rejects(
      database.repositoryCursor.create({
        data: {
          repositoryId,
          lastSuccessfullyReviewedSha: HEAD_SHA,
        },
      }),
    );
    await assert.rejects(
      database.reviewJob.create({
        data: {
          repositoryId,
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
          mode: "INCREMENTAL",
          deduplicationKey: "invalid-leased-state",
          status: "LEASED",
        },
      }),
    );
  });

  it("claims bounded disjoint batches across concurrent workers", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.enqueue({
          repositoryId,
          baseSha: index === 0 ? null : `${index}`.repeat(40),
          headSha: `${index + 1}`.repeat(40),
          mode: "RECONCILIATION",
          availableAt: now,
        }),
      ),
    );

    const [workerOne, workerTwo] = await Promise.all([
      store.claimDue({
        claimId: claimId(1),
        workerId: "worker-one",
        limit: 3,
        leaseForMs: 60_000,
        now,
      }),
      store.claimDue({
        claimId: claimId(2),
        workerId: "worker-two",
        limit: 3,
        leaseForMs: 60_000,
        now,
      }),
    ]);

    assert.equal(workerOne.length, 3);
    assert.equal(workerTwo.length, 3);
    const claimedIds = [...workerOne, ...workerTwo].map((job) => job.id);
    assert.equal(new Set(claimedIds).size, 6);
    assert.ok(
      [...workerOne, ...workerTwo].every(
        (job) => job.status === "LEASED" && job.leaseToken !== null,
      ),
    );
  });

  it("replays a claim invocation without leasing another batch", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.enqueue({
          repositoryId,
          baseSha: index === 0 ? null : `${index}`.repeat(40),
          headSha: `${index + 1}`.repeat(40),
          mode: "RECONCILIATION",
          availableAt: now,
        }),
      ),
    );

    const claim = {
      claimId: "7a0dd3fd-5c64-4266-a629-a90974e5cba5",
      workerId: "worker-one",
      limit: 2,
      leaseForMs: 60_000,
      now,
    };
    const first = await store.claimDue(claim);
    const replay = await store.claimDue({
      ...claim,
      now: new Date("2026-07-22T09:00:10.000Z"),
    });

    assert.deepEqual(
      replay.map((job) => job.id).sort(),
      first.map((job) => job.id).sort(),
    );
    assert.equal(await database.reviewJob.count({ where: { status: "LEASED" } }), 2);
  });

  it("persists an empty claim so its replay cannot lease later work", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const claim = {
      claimId: claimId(9),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 60_000,
      now,
    };

    assert.deepEqual(await store.claimDue(claim), []);
    await store.enqueue({
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });

    assert.deepEqual(await store.claimDue(claim), []);
    assert.equal(
      (await store.claimDue({ ...claim, claimId: claimId(10) })).length,
      1,
    );
  });

  it("rejects reuse of a claim ID with different parameters", async () => {
    const claim = {
      claimId: claimId(11),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 60_000,
      now: new Date("2026-07-22T09:00:00.000Z"),
    };
    await store.claimDue(claim);

    await assert.rejects(
      store.claimDue({ ...claim, workerId: "worker-two" }),
      ReviewJobClaimConflictError,
    );
  });

  it("completes a lease exactly once", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    await store.enqueue({
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });
    const [claimed] = await store.claimDue({
      claimId: claimId(3),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 60_000,
      now,
    });
    assert.ok(claimed?.leaseToken);

    const first = await store.complete({
      jobId: claimed.id,
      leaseToken: claimed.leaseToken,
      completedAt: new Date("2026-07-22T09:00:10.000Z"),
    });
    const replay = await store.complete({
      jobId: claimed.id,
      leaseToken: claimed.leaseToken,
      completedAt: new Date("2026-07-22T09:00:10.000Z"),
    });

    assert.equal(first.status, "COMPLETED");
    assert.equal(replay.id, first.id);
    assert.equal(
      await database.auditEvent.count({ where: { eventType: "review_job_completed" } }),
      1,
    );
    await assert.rejects(
      store.complete({
        jobId: claimed.id,
        leaseToken: "b86af49e-dc8e-45a2-851c-fc928e43499c",
        completedAt: new Date("2026-07-22T09:00:10.000Z"),
      }),
      ReviewJobLeaseConflictError,
    );
  });

  it("records a failure once and makes a retry available later", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const retryAt = new Date("2026-07-22T09:05:00.000Z");
    await store.enqueue({
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });
    const [claimed] = await store.claimDue({
      claimId: claimId(4),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 60_000,
      now,
    });
    assert.ok(claimed?.leaseToken);

    const failure = {
      jobId: claimed.id,
      leaseToken: claimed.leaseToken,
      failedAt: new Date("2026-07-22T09:00:10.000Z"),
      retryAt,
      code: "GITHUB_UNAVAILABLE",
      message: "GitHub could not be reached.",
    };
    const first = await store.fail(failure);
    const replay = await store.fail(failure);

    assert.equal(first.status, "PENDING");
    assert.equal(replay.id, first.id);
    assert.deepEqual(first.availableAt, retryAt);
    assert.equal(
      await database.auditEvent.count({ where: { eventType: "review_job_failed" } }),
      1,
    );
    assert.equal(
      (await store.claimDue({
        claimId: claimId(5),
        workerId: "worker-two",
        limit: 1,
        leaseForMs: 60_000,
        now,
      })).length,
      0,
    );
  });

  it("records a terminal failure exactly once when no retry is requested", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    await store.enqueue({
      repositoryId,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });
    const [claimed] = await store.claimDue({
      claimId: claimId(6),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 60_000,
      now,
    });
    assert.ok(claimed?.leaseToken);

    const failure = {
      jobId: claimed.id,
      leaseToken: claimed.leaseToken,
      failedAt: new Date("2026-07-22T09:00:10.000Z"),
      code: "INVALID_REPOSITORY_STATE",
      message: "The repository state cannot be reviewed.",
    };
    const first = await store.fail(failure);
    const replay = await store.fail(failure);

    assert.equal(first.status, "FAILED");
    assert.deepEqual(first.failedAt, failure.failedAt);
    assert.equal(replay.id, first.id);
    assert.equal(
      await database.auditEvent.count({ where: { eventType: "review_job_failed" } }),
      1,
    );
  });

  it("recovers an expired lease once and permits a new claim", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    await store.enqueue({
      repositoryId,
      baseSha: HEAD_SHA,
      headSha: LATER_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });
    const [expiredClaim] = await store.claimDue({
      claimId: claimId(7),
      workerId: "worker-one",
      limit: 1,
      leaseForMs: 1_000,
      now,
    });
    assert.ok(expiredClaim?.leaseToken);

    const recoveryTime = new Date("2026-07-22T09:00:02.000Z");
    assert.equal(
      (await store.recoverExpiredLeases({ now: recoveryTime, limit: 10 })).length,
      1,
    );
    assert.equal(
      (await store.recoverExpiredLeases({ now: recoveryTime, limit: 10 })).length,
      0,
    );
    assert.equal(
      (await store.claimDue({
        claimId: claimId(7),
        workerId: "worker-one",
        limit: 1,
        leaseForMs: 1_000,
        now: recoveryTime,
      })).length,
      0,
    );

    const [reclaimed] = await store.claimDue({
      claimId: claimId(8),
      workerId: "worker-two",
      limit: 1,
      leaseForMs: 60_000,
      now: recoveryTime,
    });
    assert.ok(reclaimed?.leaseToken);
    assert.notEqual(reclaimed.leaseToken, expiredClaim.leaseToken);
    assert.equal(reclaimed.attemptCount, 2);
  });

  it("excludes archived repositories from claims", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const archivedRepo = await database.repositoryRegistry.create({
      data: {
        githubRepositoryId: "999001",
        repositoryFullName: "example/archived-repo",
        defaultBranch: "main",
        defaultBranchHeadSha: HEAD_SHA,
        isArchived: true,
        lastInventoryRefreshAt: new Date("2026-07-22T08:00:00.000Z"),
      },
    });
    await store.enqueue({
      repositoryId: archivedRepo.id,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });

    const claimed = await store.claimDue({
      claimId: claimId(20),
      workerId: "worker-one",
      limit: 10,
      leaseForMs: 60_000,
      now,
    });

    assert.equal(claimed.length, 0);
  });

  it("excludes paused repositories from claims", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const pausedRepo = await database.repositoryRegistry.create({
      data: {
        githubRepositoryId: "999002",
        repositoryFullName: "example/paused-repo",
        defaultBranch: "main",
        defaultBranchHeadSha: HEAD_SHA,
        isPaused: true,
        lastInventoryRefreshAt: new Date("2026-07-22T08:00:00.000Z"),
      },
    });
    await store.enqueue({
      repositoryId: pausedRepo.id,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "RECONCILIATION",
      availableAt: now,
    });

    const claimed = await store.claimDue({
      claimId: claimId(21),
      workerId: "worker-one",
      limit: 10,
      leaseForMs: 60_000,
      now,
    });

    assert.equal(claimed.length, 0);
  });

  it("excludes repositories no longer accessible to the GitHub App", async () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const inaccessibleRepo = await database.repositoryRegistry.create({
      data: {
        githubRepositoryId: "999003",
        repositoryFullName: "example/inaccessible-repo",
        defaultBranch: "main",
        defaultBranchHeadSha: HEAD_SHA,
        isAccessible: false,
        lastInventoryRefreshAt: new Date("2026-07-22T08:00:00.000Z"),
      },
    });
    await store.enqueue({
      repositoryId: inaccessibleRepo.id,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      availableAt: now,
    });

    const claimed = await store.claimDue({
      claimId: claimId(22),
      workerId: "worker-one",
      limit: 10,
      leaseForMs: 60_000,
      now,
    });

    assert.equal(claimed.length, 0);
  });
});

function configureTestcontainers(): void {
  const dockerHost = process.env.DOCKER_HOST?.toLowerCase();
  const usesPodman = dockerHost?.includes("podman") === true;
  const usesMacOsPodman = usesPodman && process.platform === "darwin";
  const usesRootlessLinuxPodman =
    usesPodman && dockerHost?.includes("/run/user/") === true;

  if (
    process.env.TESTCONTAINERS_RYUK_DISABLED === undefined &&
    (usesMacOsPodman || usesRootlessLinuxPodman)
  ) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  }
}
