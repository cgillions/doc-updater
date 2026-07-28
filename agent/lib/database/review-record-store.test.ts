import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { ChangeProposalStore } from "./change-proposal-store.ts";
import { EvidenceClaimStore } from "./evidence-claim-store.ts";
import { RepositoryPullRequestStore } from "./repository-pull-request-store.ts";
import { ReviewCompletionStore } from "./review-completion-store.ts";
import { ReviewJobStore } from "./review-job-store.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const LEASE_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("review evidence and proposal stores with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let evidenceStore: EvidenceClaimStore;
  let proposalStore: ChangeProposalStore;
  let pullRequestStore: RepositoryPullRequestStore;
  let completionStore: ReviewCompletionStore;

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
      "../../../prisma/migrations/202608010001_behavior_comparisons/migration.sql",
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();

    database = createDatabaseClient({ connectionString });
    evidenceStore = new EvidenceClaimStore(database);
    proposalStore = new ChangeProposalStore(database);
    pullRequestStore = new RepositoryPullRequestStore(database);
    completionStore = new ReviewCompletionStore(database);
  });

  after(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        change_proposal_evidence,
        change_proposals,
        evidence_claims,
        audit_events,
        review_jobs,
        review_job_claim_invocations,
        repository_cursors,
        repository_registry
      CASCADE
    `);
  });

  it("records and replays evidence bound to the job SHA and scope", async () => {
    const job = await createLeasedJob(database);
    const input = confluenceEvidenceInput("12345");

    const first = await evidenceStore.record(job.id, input);
    const replay = await evidenceStore.record(job.id, input);

    assert.equal(replay.id, first.id);
    assert.equal(first.implementationSha, HEAD_SHA);
    assert.equal(first.documentation.kind, "confluence");
    assert.equal(await database.evidenceClaim.count(), 1);
  });

  it("rejects a Confluence evidence target outside the job scope", async () => {
    const job = await createLeasedJob(database);

    await assert.rejects(
      evidenceStore.record(job.id, confluenceEvidenceInput("99999")),
      ReviewRecordConflictError,
    );
    assert.equal(await database.evidenceClaim.count(), 0);
  });

  it("replays an existing record after repository eligibility changes", async () => {
    const job = await createLeasedJob(database);
    const input = repositoryEvidenceInput();
    const first = await evidenceStore.record(job.id, input);
    await database.repositoryRegistry.update({
      where: { id: job.repositoryId },
      data: { isAccessible: false },
    });

    const replay = await evidenceStore.record(job.id, input);

    assert.equal(replay.id, first.id);
    await assert.rejects(
      evidenceStore.record(job.id, {
        ...input,
        claim: "A different claim cannot be created.",
      }),
    );
  });

  it("creates one immutable proposal from evidence in the same job", async () => {
    const job = await createLeasedJob(database);
    const evidence = await evidenceStore.record(
      job.id,
      repositoryEvidenceInput(),
    );
    const input = {
      target: {
        kind: "repository" as const,
        path: "docs/orders.md",
      },
      patch: {
        kind: "repository-file-replacement" as const,
        content: "# Orders\n\nSend an idempotency key.",
      },
      evidenceClaimIds: [evidence.id],
    };

    const first = await proposalStore.create(job.id, input);
    const replay = await proposalStore.create(job.id, input);

    assert.equal(replay.id, first.id);
    assert.equal(first.repositoryBaselineSha, HEAD_SHA);
    assert.equal(await database.changeProposal.count(), 1);
    await assert.rejects(
      database.changeProposal.update({
        where: { id: first.id },
        data: { patch: { kind: "changed" } },
      }),
      /immutable/,
    );
  });

  it("loads a digest-verified repository proposal and records one idempotent pull-request artifact", async () => {
    const job = await createLeasedJob(database);
    const evidence = await evidenceStore.record(job.id, repositoryEvidenceInput());
    const proposal = await proposalStore.create(job.id, {
      target: { kind: "repository", path: "docs/orders.md" },
      patch: {
        kind: "repository-file-replacement",
        content: "# Orders\n\nUse an idempotency key.",
      },
      evidenceClaimIds: [evidence.id],
    });

    const stored = await pullRequestStore.loadProposal(job.id, proposal.digest);
    assert.deepEqual(stored, {
      id: proposal.id,
      reviewJobId: job.id,
      repositoryId: job.repositoryId,
      repositoryFullName: "example/orders",
      defaultBranch: "main",
      digest: proposal.digest,
      baseSha: HEAD_SHA,
      path: "docs/orders.md",
      content: "# Orders\n\nUse an idempotency key.",
    });

    const first = await pullRequestStore.recordCreated({
      proposal: stored!,
      idempotencyKey: `repository-pull-request:repository-pr-v1:${proposal.digest}`,
      branchName: "docs/proposal-123456789abc",
      commitSha: "e".repeat(40),
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.example/example/orders/pull/17",
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });
    const replay = await pullRequestStore.recordCreated({
      proposal: stored!,
      idempotencyKey: `repository-pull-request:repository-pr-v1:${proposal.digest}`,
      branchName: "docs/proposal-123456789abc",
      commitSha: "e".repeat(40),
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.example/example/orders/pull/17",
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });

    assert.deepEqual(replay, first);
    assert.equal(
      await database.auditEvent.count({
        where: { eventType: "repository_pull_request_created" },
      }),
      1,
    );
    const audit = await database.auditEvent.findUniqueOrThrow({
      where: {
        idempotencyKey: `repository-pull-request:repository-pr-v1:${proposal.digest}`,
      },
    });
    assert.deepEqual(audit.details, {
      proposalId: proposal.id,
      approvalOutcome: "approved",
      sessionId: "session-123",
      toolCallId: "call-123",
      ...first,
    });
  });

  it("binds Confluence proposals to evidence for the exact page baseline", async () => {
    const job = await createLeasedJob(database);
    const evidence = await evidenceStore.record(
      job.id,
      confluenceEvidenceInput("12345"),
    );
    const input = {
      target: {
        kind: "confluence" as const,
        siteId: "example-site",
        pageId: "12345",
        version: 7,
        bodyHash: "d".repeat(64),
      },
      patch: {
        kind: "confluence-storage-fragment-replacement" as const,
        baselineStorageValue: "<h2>Orders</h2><p>Current</p>",
        baselineFragmentHash: "e".repeat(64),
        replacementStorageValue: "<h2>Orders</h2><p>Updated</p>",
      },
      evidenceClaimIds: [evidence.id],
    };

    const proposal = await proposalStore.create(job.id, input);

    assert.equal(proposal.repositoryBaselineSha, null);
    assert.equal(proposal.target.kind, "confluence");
    await assert.rejects(
      proposalStore.create(job.id, {
        ...input,
        target: {
          ...input.target,
          version: 8,
        },
      }),
      ReviewRecordConflictError,
    );
  });

  it("rejects evidence belonging to a different review job", async () => {
    const firstJob = await createLeasedJob(database, "first", "101");
    const secondJob = await createLeasedJob(database, "second", "102");
    const evidence = await evidenceStore.record(
      firstJob.id,
      repositoryEvidenceInput(),
    );

    await assert.rejects(
      proposalStore.create(secondJob.id, {
        target: { kind: "repository", path: "docs/orders.md" },
        patch: {
          kind: "repository-file-replacement",
          content: "replacement",
        },
        evidenceClaimIds: [evidence.id],
      }),
      ReviewRecordConflictError,
    );
  });

  it("completes a reviewed job and advances its cursor exactly once", async () => {
    const job = await createLeasedJob(database);
    await evidenceStore.record(job.id, repositoryEvidenceInput());
    const input = {
      outcome: "in-sync" as const,
      summary: "The checked documentation matches the implementation.",
    };

    const first = await completionStore.complete(job.id, input);
    const replay = await completionStore.complete(job.id, input);
    const cursor = await database.repositoryCursor.findUniqueOrThrow({
      where: { repositoryId: job.repositoryId },
    });

    assert.deepEqual(replay, first);
    assert.equal(first.cursorAdvanced, true);
    assert.equal(cursor.lastSuccessfullyReviewedSha, HEAD_SHA);
    assert.equal(
      await database.auditEvent.count({
        where: { eventType: "review_job_outcome_recorded" },
      }),
      1,
    );
  });

  it("rejects an in-sync outcome when final-head documentation is contradictory", async () => {
    const job = await createLeasedJob(database);
    await evidenceStore.record(job.id, {
      ...repositoryEvidenceInput(),
      claim:
        "The documentation requires approval on every call, while the " +
        "implementation requires it only once per session.",
      implementationReferences: [
        {
          path: "agent/tools/create_repository_pull_request.ts",
          startLine: 1,
          endLine: 22,
        },
      ],
      documentation: {
        kind: "repository",
        path: "docs/system-plan.md",
      },
      behaviorComparisons: [{
        behavior: "Approval frequency for repository pull-request creation.",
        base: {
          status: "present",
          excerpt: "approval: always()",
        },
        head: {
          status: "present",
          excerpt: "approval: once()",
        },
        changeDirection: "modified",
        documentationAtHead: {
          claim: "Approval is required on every invocation.",
          excerpt:
            "`create_repository_pull_request` declares Eve's `always()` policy.",
        },
        classification: "contradictory",
        rationale:
          "The final-head documentation states every invocation while the " +
          "final implementation approves only the first call in a session.",
      }],
    });

    await assert.rejects(
      completionStore.complete(job.id, {
        outcome: "in-sync",
        summary: "Both policies are approval-gated.",
      }),
      ReviewRecordConflictError,
    );
  });

  it("records incomplete outcomes without advancing the cursor", async () => {
    const job = await createLeasedJob(
      database,
      "orders",
      "100",
      { baseSha: null },
    );
    const result = await completionStore.complete(job.id, {
      outcome: "incomplete",
      summary: "A required documentation baseline could not be verified.",
    });

    assert.equal(result.cursorAdvanced, false);
    assert.equal(
      await database.repositoryCursor.findUnique({
        where: { repositoryId: job.repositoryId },
      }),
      null,
    );
    assert.equal(
      await new ReviewJobStore(database).hasRecordedOutcome(
        job.id,
        LEASE_TOKEN,
      ),
      true,
    );
  });

  it("requires a persisted proposal for proposal-created outcomes", async () => {
    const job = await createLeasedJob(database);
    await evidenceStore.record(job.id, {
      ...repositoryEvidenceInput(),
      behaviorComparisons: [contradictoryBehaviorComparison()],
    });

    await assert.rejects(
      completionStore.complete(job.id, {
        outcome: "proposal-created",
        summary: "A proposal was prepared.",
      }),
      ReviewRecordConflictError,
    );
  });

  it("completes proposal-created when contradictory evidence has a persisted proposal", async () => {
    const job = await createLeasedJob(database);
    const evidence = await evidenceStore.record(job.id, {
      ...repositoryEvidenceInput(),
      behaviorComparisons: [contradictoryBehaviorComparison()],
    });
    await proposalStore.create(job.id, {
      target: {
        kind: "repository",
        path: "docs/orders.md",
      },
      patch: {
        kind: "repository-file-replacement",
        content: "# Orders\n\nSend an idempotency key with every request.",
      },
      evidenceClaimIds: [evidence.id],
    });

    const completed = await completionStore.complete(job.id, {
      outcome: "proposal-created",
      summary: "A verified correction was persisted.",
    });

    assert.equal(completed.outcome, "proposal-created");
    assert.equal(completed.cursorAdvanced, true);
  });
});

async function createLeasedJob(
  database: DatabaseClient,
  name = "orders",
  githubRepositoryId = "100",
  options: { baseSha?: string | null } = {},
) {
  const baseSha =
    options.baseSha === undefined ? BASE_SHA : options.baseSha;
  const repository = await database.repositoryRegistry.create({
    data: {
      githubRepositoryId,
      repositoryFullName: `example/${name}`,
      defaultBranch: "main",
      defaultBranchHeadSha: HEAD_SHA,
      roadieScopeStatus: "RESOLVED",
      componentRef: `component:default/${name}`,
      systemRef: "system:default/example-system",
      ownerRef: "group:default/example-team",
      slackChannelId: "C0123456789",
      documentationScope: [
        {
          siteId: "example-site",
          pageId: "12345",
          declarations: [
            {
              kind: "exact",
              excludedPageIds: [],
              provenance: {
                entityRef: "group:default/example-team",
                url:
                  "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/12345",
              },
            },
          ],
        },
      ],
      configurationHash: "c".repeat(64),
      roadieDiagnostics: [],
      lastRoadieRefreshAt: new Date("2026-07-29T06:00:00.000Z"),
      lastInventoryRefreshAt: new Date("2026-07-29T06:00:00.000Z"),
    },
  });
  if (baseSha) {
    await database.repositoryCursor.create({
      data: {
        repositoryId: repository.id,
        lastSuccessfullyReviewedSha: baseSha,
        lastSuccessfullyReviewedAt: new Date(
          "2026-07-28T07:00:00.000Z",
        ),
      },
    });
  }
  return database.reviewJob.create({
    data: {
      repositoryId: repository.id,
      baseSha,
      headSha: HEAD_SHA,
      mode: "INCREMENTAL",
      deduplicationKey: `job-${name}`,
      status: "LEASED",
      attemptCount: 1,
      leaseOwner: "dispatcher",
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt: new Date("2099-07-29T07:30:00.000Z"),
    },
  });
}

function repositoryEvidenceInput() {
  return {
    claim: "The endpoint requires an idempotency key.",
    implementationReferences: [
      { path: "src/routes/orders.ts", startLine: 20, endLine: 28 },
    ],
    documentation: {
      kind: "repository" as const,
      path: "docs/orders.md",
    },
    behaviorComparisons: [consistentBehaviorComparison()],
    confidenceReasons: ["The behavior is enforced by the route."],
  };
}

function confluenceEvidenceInput(pageId: string) {
  return {
    claim: "The endpoint requires an idempotency key.",
    implementationReferences: [{ path: "src/routes/orders.ts" }],
    documentation: {
      kind: "confluence" as const,
      siteId: "example-site",
      pageId,
      version: 7,
      bodyHash: "d".repeat(64),
    },
    behaviorComparisons: [consistentBehaviorComparison()],
    confidenceReasons: ["The behavior is enforced by the route."],
  };
}

function consistentBehaviorComparison() {
  return {
    behavior: "Order creation requires an idempotency key.",
    base: {
      status: "present" as const,
      excerpt: "The idempotency key is optional.",
    },
    head: {
      status: "present" as const,
      excerpt: "The idempotency key is required.",
    },
    changeDirection: "modified" as const,
    documentationAtHead: {
      claim: "The idempotency key is required.",
      excerpt: "Send an idempotency key with every request.",
    },
    classification: "consistent" as const,
    rationale: "The final-head documentation matches the final behavior.",
  };
}

function contradictoryBehaviorComparison() {
  return {
    ...consistentBehaviorComparison(),
    documentationAtHead: {
      claim: "The idempotency key is optional.",
      excerpt: "An idempotency key may be sent with a request.",
    },
    classification: "contradictory" as const,
    rationale:
      "The final implementation requires the key while the documentation " +
      "still describes it as optional.",
  };
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
