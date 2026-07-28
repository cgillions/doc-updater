import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { ConfluencePageStore } from "./confluence-page-store.ts";

describe("ConfluencePageStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let store: ConfluencePageStore;

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
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();
    database = createDatabaseClient({ connectionString });
    store = new ConfluencePageStore(database);
  });

  after(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        review_job_confluence_candidates,
        confluence_page_snapshots,
        audit_events,
        review_jobs,
        review_job_claim_invocations,
        repository_cursors,
        repository_registry
      CASCADE
    `);
  });

  it("reuses one immutable page version across repository review jobs", async () => {
    const firstJob = await createJob(database, "first", "101");
    const secondJob = await createJob(database, "second", "102");
    const target = {
      siteId: "example.atlassian.net",
      pageId: "12345",
      label: "Shared handbook",
    };
    const [firstCandidate] = await store.materializeCandidates(
      firstJob.id,
      [target],
    );
    const [secondCandidate] = await store.materializeCandidates(
      secondJob.id,
      [target],
    );

    const [first, second] = await Promise.all([
      store.attachSnapshot(
        firstJob.id,
        firstCandidate!.id,
        page(),
      ),
      store.attachSnapshot(
        secondJob.id,
        secondCandidate!.id,
        page(),
      ),
    ]);

    assert.equal(first.snapshot?.id, second.snapshot?.id);
    assert.equal(await database.confluencePageSnapshot.count(), 1);
    assert.equal(
      await database.reviewJobConfluenceCandidate.count(),
      2,
    );
    await assert.rejects(
      database.confluencePageSnapshot.update({
        where: { id: first.snapshot!.id },
        data: { title: "Changed" },
      }),
      /immutable/,
    );
  });

  it("rejects changed content for an existing page version", async () => {
    const job = await createJob(database, "orders", "103");
    const [candidate] = await store.materializeCandidates(job.id, [{
      siteId: "example.atlassian.net",
      pageId: "12345",
      label: "Orders",
    }]);
    await store.attachSnapshot(job.id, candidate!.id, page());

    await assert.rejects(
      store.attachSnapshot(job.id, candidate!.id, {
        ...page(),
        bodyStorageValue: "<p>Different</p>",
        bodyHash: "e".repeat(64),
      }),
      ReviewRecordConflictError,
    );
  });
});

async function createJob(
  database: DatabaseClient,
  name: string,
  githubRepositoryId: string,
) {
  const repository = await database.repositoryRegistry.create({
    data: {
      githubRepositoryId,
      repositoryFullName: `example/${name}`,
      defaultBranch: "main",
      defaultBranchHeadSha: "a".repeat(40),
      lastInventoryRefreshAt: new Date(),
    },
  });
  return database.reviewJob.create({
    data: {
      repositoryId: repository.id,
      headSha: "a".repeat(40),
      mode: "RECONCILIATION",
      deduplicationKey: `job-${name}`,
    },
  });
}

function page() {
  return {
    siteId: "example.atlassian.net",
    pageId: "12345",
    version: 7,
    status: "current",
    title: "Shared handbook",
    spaceId: "987",
    parentId: null,
    bodyStorageValue: "<h1>Shared</h1><p>Content</p>",
    bodyHash: "d".repeat(64),
    fetchedAt: new Date("2026-07-28T12:00:00.000Z"),
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
