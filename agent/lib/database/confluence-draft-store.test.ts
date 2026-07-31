import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { ChangeProposalStore } from "./change-proposal-store.ts";
import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { ConfluenceDraftStore } from "./confluence-draft-store.ts";
import { ConfluencePageUpdateStore } from "./confluence-page-update-store.ts";
import { EvidenceClaimStore } from "./evidence-claim-store.ts";
import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";

const HEAD_SHA = "b".repeat(40);

describe("ConfluenceDraftStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let evidenceStore: EvidenceClaimStore;
  let proposalStore: ChangeProposalStore;
  let draftStore: ConfluenceDraftStore;
  let pageUpdateStore: ConfluencePageUpdateStore;

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
      "../../../prisma/migrations/202607300001_confluence_exact_page_snapshots/migration.sql",
      "../../../prisma/migrations/202607310001_review_job_retry_attempts/migration.sql",
      "../../../prisma/migrations/202608010001_behavior_comparisons/migration.sql",
      "../../../prisma/migrations/202608020001_confluence_draft_artifacts/migration.sql",
      "../../../prisma/migrations/202608030001_confluence_draft_artifact_history/migration.sql",
      "../../../prisma/migrations/202608040001_confluence_page_update_artifacts/migration.sql",
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
    draftStore = new ConfluenceDraftStore(database);
    pageUpdateStore = new ConfluencePageUpdateStore(database);
  });

  after(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        confluence_page_update_artifacts,
        confluence_draft_artifacts,
        review_job_confluence_candidates,
        confluence_page_snapshots,
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

  it("records the published version and human review links", async () => {
    const job = await createLeasedJob(database);
    const proposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      job.id,
    );
    const stored = await pageUpdateStore.loadProposal(job.id, proposal.digest);

    const record = await pageUpdateStore.recordPublished({
      proposal: stored!,
      pageId: "12345",
      publishedVersion: 8,
      pageUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
      historyUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });

    assert.deepEqual(record, {
      proposalDigest: proposal.digest,
      pageId: "12345",
      publishedVersion: 8,
      pageUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
      historyUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
      status: "published",
    });
    assert.equal(await database.confluencePageUpdateArtifact.count(), 1);
    const audit = await database.auditEvent.findFirstOrThrow({
      where: { eventType: "confluence_page_update_published" },
    });
    assert.deepEqual(audit.details, {
      proposalId: proposal.id,
      approvalOutcome: "approved",
      sessionId: "session-123",
      toolCallId: "call-123",
      ...record,
    });
  });

  it("loads an exact-page proposal and records immutable draft history", async () => {
    const job = await createLeasedJob(database);
    const proposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      job.id,
    );

    const stored = await draftStore.loadProposal(job.id, proposal.digest);

    assert.deepEqual(stored, {
      id: proposal.id,
      repositoryId: job.repositoryId,
      reviewJobId: job.id,
      digest: proposal.digest,
      implementationSha: HEAD_SHA,
      target: {
        siteId: "example.atlassian.net",
        pageId: "12345",
        version: 7,
        bodyHash: "d".repeat(64),
      },
      patch: {
        baselineStorageValue: "<p>Current</p>",
        baselineFragmentHash: "e".repeat(64),
        replacementStorageValue: "<p>Updated</p>",
      },
    });

    const first = await draftStore.recordCreated({
      proposal: stored!,
      draftPageId: "12345",
      draftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });
    const later = await draftStore.recordCreated({
      proposal: stored!,
      draftPageId: "12345",
      draftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });

    assert.deepEqual(later, first);
    assert.deepEqual(first, {
      proposalDigest: proposal.digest,
      pageId: "12345",
      draftPageId: "12345",
      draftVersion: 8,
      status: "draft",
    });
    assert.equal(await database.confluenceDraftArtifact.count(), 2);
    const artifact = await database.confluenceDraftArtifact.findFirstOrThrow({
      where: { proposalDigest: proposal.digest },
    });
    await assert.rejects(
      database.confluenceDraftArtifact.update({
        where: { id: artifact.id },
        data: { draftVersion: 9 },
      }),
      /immutable/,
    );
    assert.equal(
      await database.auditEvent.count({
        where: { eventType: "confluence_draft_created" },
      }),
      2,
    );
    const audit = await database.auditEvent.findFirstOrThrow({
      where: {
        eventType: "confluence_draft_created",
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

  it("records a Confluence-reported draft block without reading local draft history", async () => {
    const firstJob = await createLeasedJob(database, "orders", "101");
    const secondJob = await createLeasedJob(database, "billing", "102");
    const firstProposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      firstJob.id,
    );
    const secondProposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      secondJob.id,
      "<p>Billing update</p>",
    );
    const first = await draftStore.loadProposal(firstJob.id, firstProposal.digest);
    const second = await draftStore.loadProposal(secondJob.id, secondProposal.digest);

    await draftStore.recordCreated({
      proposal: first!,
      draftPageId: "12345",
      draftVersion: 8,
      actorId: undefined,
      sessionId: undefined,
      toolCallId: undefined,
    });

    const blocked = await draftStore.recordBlockedByExistingDraft({
      proposal: second!,
      existingDraftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-456",
      toolCallId: "call-456",
    });
    const replay = await draftStore.recordBlockedByExistingDraft({
      proposal: second!,
      existingDraftVersion: 8,
      actorId: "U87654321",
      sessionId: "session-789",
      toolCallId: "call-789",
    });

    assert.deepEqual(blocked, {
      proposalDigest: secondProposal.digest,
      pageId: "12345",
      status: "blocked-existing-draft",
    });
    assert.deepEqual(replay, blocked);
    assert.equal(await database.changeProposal.count(), 2);
    assert.equal(await database.confluenceDraftArtifact.count(), 1);
    const audit = await database.auditEvent.findUniqueOrThrow({
      where: {
        idempotencyKey:
          `confluence-draft-blocked:confluence-draft-v1:${secondProposal.digest}:8`,
      },
    });
    assert.equal(audit.eventType, "confluence_draft_blocked_existing_draft");
    assert.deepEqual(audit.details, {
      proposalId: second!.id,
      observedDraftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-456",
      toolCallId: "call-456",
      ...blocked,
    });
  });

  it("retains artifacts for an old draft without making them an active page gate", async () => {
    const firstJob = await createLeasedJob(database, "orders", "101");
    const secondJob = await createLeasedJob(database, "billing", "102");
    const firstProposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      firstJob.id,
    );
    const secondProposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      secondJob.id,
      "<p>Billing update</p>",
    );
    const first = await draftStore.loadProposal(firstJob.id, firstProposal.digest);
    const second = await draftStore.loadProposal(secondJob.id, secondProposal.digest);

    await draftStore.recordCreated({
      proposal: first!,
      draftPageId: "12345",
      draftVersion: 8,
      actorId: undefined,
      sessionId: undefined,
      toolCallId: undefined,
    });
    await draftStore.recordCreated({
      proposal: second!,
      draftPageId: "12345",
      draftVersion: 9,
      actorId: undefined,
      sessionId: undefined,
      toolCallId: undefined,
    });

    const artifacts = await database.confluenceDraftArtifact.findMany({
      where: {
        siteId: "example.atlassian.net",
        pageId: "12345",
      },
      orderBy: { draftVersion: "asc" },
    });
    assert.deepEqual(
      artifacts.map(({ proposalDigest, draftVersion }) => ({
        proposalDigest,
        draftVersion,
      })),
      [
        { proposalDigest: firstProposal.digest, draftVersion: 8 },
        { proposalDigest: secondProposal.digest, draftVersion: 9 },
      ],
    );
  });

  it("does not load a root-only proposal for draft creation", async () => {
    const job = await createLeasedJob(database, "orders", "101", "root");
    const proposal = await createConfluenceProposal(
      evidenceStore,
      proposalStore,
      job.id,
    );

    assert.equal(
      await draftStore.loadProposal(job.id, proposal.digest),
      null,
    );
  });

  it("serializes two creation attempts for the same Confluence page", async () => {
    const target = { siteId: "example.atlassian.net", pageId: "12345" };
    const entered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });

    const first = draftStore.withPageLock(target, async () => {
      entered.push("first");
      enteredFirst!();
      await firstReleased;
    });
    await firstEntered;
    const second = draftStore.withPageLock(target, async () => {
      entered.push("second");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(entered, ["first"]);
    releaseFirst!();
    await Promise.all([first, second]);
    assert.deepEqual(entered, ["first", "second"]);
  });
});

async function createConfluenceProposal(
  evidenceStore: EvidenceClaimStore,
  proposalStore: ChangeProposalStore,
  reviewJobId: string,
  replacementStorageValue = "<p>Updated</p>",
) {
  const evidence = await evidenceStore.record(reviewJobId, {
    claim: "The orders documentation needs an update.",
    implementationReferences: [{ path: "src/orders.ts", startLine: 1 }],
    documentation: {
      kind: "confluence",
      siteId: "example.atlassian.net",
      pageId: "12345",
      version: 7,
      bodyHash: "d".repeat(64),
    },
    behaviorComparisons: [contradictoryBehaviorComparison()],
    confidenceReasons: ["The implementation and documentation disagree."],
  });
  return proposalStore.create(reviewJobId, {
    target: {
      kind: "confluence",
      siteId: "example.atlassian.net",
      pageId: "12345",
      version: 7,
      bodyHash: "d".repeat(64),
    },
    patch: {
      kind: "confluence-storage-fragment-replacement",
      baselineStorageValue: "<p>Current</p>",
      baselineFragmentHash: "e".repeat(64),
      replacementStorageValue,
    },
    evidenceClaimIds: [evidence.id],
  });
}

async function createLeasedJob(
  databaseClient: DatabaseClient,
  name = "orders",
  githubRepositoryId = "100",
  declarationKind: "exact" | "root" = "exact",
) {
  const repository = await databaseClient.repositoryRegistry.create({
    data: {
      githubRepositoryId,
      repositoryFullName: `example/${name}`,
      defaultBranch: "main",
      defaultBranchHeadSha: HEAD_SHA,
      roadieScopeStatus: "RESOLVED",
      componentRef: `component:default/${name}`,
      systemRef: "system:default/example",
      ownerRef: "group:default/example",
      slackChannelId: "C0123456789",
      documentationScope: [{
        siteId: "example.atlassian.net",
        pageId: "12345",
        declarations: [{
          kind: declarationKind,
          excludedPageIds: [],
          provenance: {
            entityRef: "group:default/example",
            title: "Orders",
            url:
              "https://example.atlassian.net/wiki/spaces/ORD/pages/12345",
          },
        }],
      }],
      configurationHash: "c".repeat(64),
      roadieDiagnostics: [],
      lastRoadieRefreshAt: new Date(),
      lastInventoryRefreshAt: new Date(),
    },
  });
  return databaseClient.reviewJob.create({
    data: {
      repositoryId: repository.id,
      headSha: HEAD_SHA,
      mode: "RECONCILIATION",
      deduplicationKey: `draft-${name}`,
      status: "LEASED",
      leaseOwner: "worker",
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
}

function contradictoryBehaviorComparison() {
  return {
    behavior: "Orders require an idempotency key.",
    base: {
      status: "present" as const,
      excerpt: "No idempotency key is required.",
    },
    head: {
      status: "present" as const,
      excerpt: "An idempotency key is required.",
    },
    changeDirection: "modified" as const,
    documentationAtHead: {
      claim: "No idempotency key is required.",
      excerpt: "<p>No idempotency key is required.</p>",
    },
    classification: "contradictory" as const,
    rationale: "The implementation now requires an idempotency key.",
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
