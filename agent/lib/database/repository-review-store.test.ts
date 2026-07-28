import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { ReviewJobContextStore } from "./review-job-context-store.ts";
import { RepositoryReviewStore } from "./repository-review-store.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

describe("RepositoryReviewStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let store: RepositoryReviewStore;
  let contextStore: ReviewJobContextStore;

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
    store = new RepositoryReviewStore(database, {
      roadieFreshAfter: new Date(0),
    });
    contextStore = new ReviewJobContextStore(database);
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
  });

  it("selects only schedulable changed repositories with the correct mode", async () => {
    const incremental = await createRepository(database, 101, "incremental");
    await database.repositoryCursor.create({
      data: {
        repositoryId: incremental.id,
        lastSuccessfullyReviewedSha: BASE_SHA,
        lastSuccessfullyReviewedAt: new Date("2026-07-28T07:00:00.000Z"),
      },
    });
    await createRepository(database, 102, "reconciliation");
    const unchanged = await createRepository(database, 103, "unchanged");
    await database.repositoryCursor.create({
      data: {
        repositoryId: unchanged.id,
        lastSuccessfullyReviewedSha: HEAD_SHA,
        lastSuccessfullyReviewedAt: new Date("2026-07-28T07:00:00.000Z"),
      },
    });
    await createRepository(database, 104, "paused", { isPaused: true });
    await createRepository(database, 105, "archived", { isArchived: true });
    await createRepository(database, 106, "inaccessible", {
      isAccessible: false,
    });
    await createRepository(database, 107, "repo-only", {
      roadieScopeStatus: "REPO_ONLY",
    });

    const candidates = await store.listDueReviewCandidates();

    assert.deepEqual(candidates, [
      {
        repositoryId: incremental.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
      },
      {
        repositoryId: (
          await database.repositoryRegistry.findUniqueOrThrow({
            where: { githubRepositoryId: "102" },
          })
        ).id,
        baseSha: null,
        headSha: HEAD_SHA,
        mode: "RECONCILIATION",
      },
    ]);
  });

  it("loads only current trusted Slack routes for claimed jobs", async () => {
    const resolved = await createRepository(database, 201, "resolved");
    const repoOnly = await createRepository(database, 202, "repo-only", {
      roadieScopeStatus: "REPO_ONLY",
    });
    const resolvedJob = await database.reviewJob.create({
      data: {
        repositoryId: resolved.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
        deduplicationKey: "resolved-route",
      },
    });
    const repoOnlyJob = await database.reviewJob.create({
      data: {
        repositoryId: repoOnly.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
        deduplicationKey: "missing-route",
      },
    });

    assert.deepEqual(
      await store.loadDispatchRoutes([repoOnlyJob.id, resolvedJob.id]),
      [
        {
          reviewJobId: resolvedJob.id,
          slackChannelId: "C0123456789",
        },
      ],
    );
  });

  it("excludes expired Roadie projections from enqueue and dispatch", async () => {
    const freshAfter = new Date("2026-07-28T05:00:00.000Z");
    const freshnessBoundStore = new RepositoryReviewStore(database, {
      roadieFreshAfter: freshAfter,
    });
    const stale = await createRepository(database, 203, "stale", {
      lastRoadieRefreshAt: new Date("2026-07-28T04:59:59.999Z"),
    });
    const staleJob = await database.reviewJob.create({
      data: {
        repositoryId: stale.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
        deduplicationKey: "stale-route",
      },
    });

    assert.deepEqual(
      await freshnessBoundStore.listDueReviewCandidates(),
      [],
    );
    assert.deepEqual(
      await freshnessBoundStore.loadDispatchRoutes([staleJob.id]),
      [],
    );
  });

  it("loads an active job with its immutable repository and Roadie scope", async () => {
    const repository = await createRepository(database, 301, "context");
    await database.repositoryRegistry.update({
      where: { id: repository.id },
      data: {
        documentationScope: [
          {
            siteId: "example-site",
            pageId: "11111",
            declarations: [
              {
                kind: "exact",
                excludedPageIds: [],
                provenance: {
                  entityRef: "group:default/example-team",
                  title: "Engineering handbook",
                  url:
                    "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/11111",
                },
              },
            ],
          },
        ],
      },
    });
    const job = await database.reviewJob.create({
      data: {
        repositoryId: repository.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
        deduplicationKey: "context-job",
        status: "LEASED",
        attemptCount: 1,
        leaseOwner: "dispatcher",
        leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        leaseExpiresAt: new Date("2026-07-29T07:30:00.000Z"),
      },
    });

    const context = await contextStore.loadActive(job.id);

    assert.deepEqual(context, {
      reviewJobId: job.id,
      mode: "INCREMENTAL",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      repository: {
        id: repository.id,
        fullName: "example/context",
        defaultBranch: "main",
      },
      roadie: {
        componentRef: "component:default/context",
        systemRef: "system:default/example-system",
        ownerRef: "group:default/example-team",
        slackChannelId: "C0123456789",
        catalogRevision: null,
        configurationHash: "a".repeat(64),
      },
      documentationScope: [
        {
          siteId: "example-site",
          pageId: "11111",
          declarations: [
            {
              kind: "exact",
              excludedPageIds: [],
              provenance: {
                entityRef: "group:default/example-team",
                title: "Engineering handbook",
                url:
                  "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/11111",
              },
            },
          ],
        },
      ],
    });
  });

  it("does not load jobs that are not actively leased", async () => {
    const repository = await createRepository(database, 302, "pending");
    const job = await database.reviewJob.create({
      data: {
        repositoryId: repository.id,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mode: "INCREMENTAL",
        deduplicationKey: "pending-context-job",
      },
    });

    assert.equal(await contextStore.loadActive(job.id), null);
  });
});

async function createRepository(
  database: DatabaseClient,
  githubRepositoryId: number,
  name: string,
  overrides: {
    isAccessible?: boolean;
    isArchived?: boolean;
    isPaused?: boolean;
    roadieScopeStatus?: "RESOLVED" | "REPO_ONLY";
    lastRoadieRefreshAt?: Date;
  } = {},
) {
  const roadieScopeStatus = overrides.roadieScopeStatus ?? "RESOLVED";
  const isResolved = roadieScopeStatus === "RESOLVED";
  return database.repositoryRegistry.create({
    data: {
      githubRepositoryId: githubRepositoryId.toString(),
      repositoryFullName: `example/${name}`,
      defaultBranch: "main",
      defaultBranchHeadSha: HEAD_SHA,
      isAccessible: overrides.isAccessible ?? true,
      isArchived: overrides.isArchived ?? false,
      isPaused: overrides.isPaused ?? false,
      roadieScopeStatus,
      componentRef: isResolved ? `component:default/${name}` : null,
      systemRef: isResolved ? "system:default/example-system" : null,
      ownerRef: isResolved ? "group:default/example-team" : null,
      slackChannelId: isResolved ? "C0123456789" : null,
      documentationScope: isResolved ? [] : undefined,
      configurationHash: isResolved ? "a".repeat(64) : null,
      roadieDiagnostics: [],
      lastRoadieRefreshAt:
        overrides.lastRoadieRefreshAt ??
        new Date("2026-07-28T06:00:00.000Z"),
      lastInventoryRefreshAt: new Date("2026-07-28T06:00:00.000Z"),
    },
  });
}

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
