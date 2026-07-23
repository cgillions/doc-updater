import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { RepositoryRegistryStore } from "./repository-registry-store.ts";

const FIRST_SHA = "a".repeat(40);
const SECOND_SHA = "b".repeat(40);

describe("RepositoryRegistryStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let store: RepositoryRegistryStore;

  before(async () => {
    configureTestcontainers();
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = container.getConnectionUri();
    const migrationPool = new Pool({ connectionString });
    for (const migrationPath of [
      "../../../prisma/migrations/202607220001_initial_control_plane/migration.sql",
      "../../../prisma/migrations/202607230001_repository_inventory_access/migration.sql",
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();

    database = createDatabaseClient({ connectionString });
    store = new RepositoryRegistryStore(database);
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

  it("creates one registry entry when the same snapshot is replayed", async () => {
    const refreshedAt = new Date("2026-07-23T09:00:00.000Z");
    const snapshot = [
      inventoryEntry("101", "example/alpha", "main", FIRST_SHA),
    ];

    const first = await store.synchronize(snapshot, refreshedAt);
    const replay = await store.synchronize(snapshot, refreshedAt);

    assert.deepEqual(first, {
      accessibleRepositoryCount: 1,
      inaccessibleRepositoryCount: 0,
    });
    assert.deepEqual(replay, first);
    assert.equal(await database.repositoryRegistry.count(), 1);
    const repository = await database.repositoryRegistry.findFirstOrThrow();
    assert.equal(repository.githubRepositoryId, "101");
    assert.equal(repository.repositoryFullName, "example/alpha");
    assert.equal(repository.defaultBranch, "main");
    assert.equal(repository.defaultBranchHeadSha, FIRST_SHA);
    assert.equal(repository.isAccessible, true);
    assert.equal(repository.isArchived, false);
    assert.deepEqual(repository.lastInventoryRefreshAt, refreshedAt);
  });

  it("updates rename, archive, branch, and head metadata by GitHub ID", async () => {
    const firstRefresh = new Date("2026-07-23T09:00:00.000Z");
    await store.synchronize(
      [inventoryEntry("201", "example/old-name", "main", FIRST_SHA)],
      firstRefresh,
    );
    await database.repositoryRegistry.updateMany({
      data: { isPaused: true },
    });

    const secondRefresh = new Date("2026-07-23T10:00:00.000Z");
    await store.synchronize(
      [
        inventoryEntry(
          "201",
          "example/new-name",
          "trunk",
          SECOND_SHA,
          true,
        ),
      ],
      secondRefresh,
    );

    const repository = await database.repositoryRegistry.findFirstOrThrow();
    assert.equal(repository.githubRepositoryId, "201");
    assert.equal(repository.repositoryFullName, "example/new-name");
    assert.equal(repository.defaultBranch, "trunk");
    assert.equal(repository.defaultBranchHeadSha, SECOND_SHA);
    assert.equal(repository.isArchived, true);
    assert.equal(repository.isAccessible, true);
    assert.equal(repository.isPaused, true);
    assert.deepEqual(repository.lastInventoryRefreshAt, secondRefresh);
  });

  it("marks removed access without deleting repository audit history", async () => {
    const firstRefresh = new Date("2026-07-23T09:00:00.000Z");
    await store.synchronize(
      [
        inventoryEntry("301", "example/retained", "main", FIRST_SHA),
        inventoryEntry("302", "example/removed", "main", FIRST_SHA),
      ],
      firstRefresh,
    );
    const removed = await database.repositoryRegistry.findUniqueOrThrow({
      where: { githubRepositoryId: "302" },
    });
    await database.auditEvent.create({
      data: {
        repositoryId: removed.id,
        eventType: "test_inventory_history",
        idempotencyKey: "test-inventory-history:302",
        details: { source: "fixture" },
      },
    });

    const secondRefresh = new Date("2026-07-23T10:00:00.000Z");
    const result = await store.synchronize(
      [inventoryEntry("301", "example/retained", "main", SECOND_SHA)],
      secondRefresh,
    );

    const removedAfterSync =
      await database.repositoryRegistry.findUniqueOrThrow({
        where: { githubRepositoryId: "302" },
      });
    assert.equal(removedAfterSync.isAccessible, false);
    assert.deepEqual(removedAfterSync.lastInventoryRefreshAt, secondRefresh);
    assert.equal(await database.auditEvent.count(), 1);
    assert.deepEqual(result, {
      accessibleRepositoryCount: 1,
      inaccessibleRepositoryCount: 1,
    });
  });

  it("rejects duplicate repository identities before changing the registry", async () => {
    const refreshedAt = new Date("2026-07-23T09:00:00.000Z");
    const duplicateSnapshot = [
      inventoryEntry("401", "example/alpha", "main", FIRST_SHA),
      inventoryEntry("401", "example/beta", "main", SECOND_SHA),
    ];

    await assert.rejects(
      store.synchronize(duplicateSnapshot, refreshedAt),
      /repository ID 401 more than once/,
    );
    assert.equal(await database.repositoryRegistry.count(), 0);
  });
});

function inventoryEntry(
  githubRepositoryId: string,
  repositoryFullName: string,
  defaultBranch: string,
  defaultBranchHeadSha: string,
  isArchived = false,
) {
  return {
    githubRepositoryId,
    repositoryFullName,
    defaultBranch,
    defaultBranchHeadSha,
    isArchived,
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
