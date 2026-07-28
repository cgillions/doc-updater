import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { RepositoryReviewStore } from "./repository-review-store.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

describe("RepositoryReviewStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let store: RepositoryReviewStore;

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
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();

    database = createDatabaseClient({ connectionString });
    store = new RepositoryReviewStore(database);
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
      lastRoadieRefreshAt: new Date("2026-07-28T06:00:00.000Z"),
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
