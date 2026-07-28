import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import type { RoadieScopeResolution } from "../domain/documentation/documentation-scope.ts";
import { createDatabaseClient, type DatabaseClient } from "./client.ts";
import { RepositoryRegistryStore } from "./repository-registry-store.ts";
import {
  RepositoryScopeBaselineError,
  RepositoryScopeStore,
} from "./repository-scope-store.ts";

const SHA = "a".repeat(40);
const REPOSITORY_ID = "101";

describe("RepositoryScopeStore with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseClient;
  let inventoryStore: RepositoryRegistryStore;
  let scopeStore: RepositoryScopeStore;

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
    ]) {
      const migration = await readFile(
        new URL(migrationPath, import.meta.url),
        "utf8",
      );
      await migrationPool.query(migration);
    }
    await migrationPool.end();

    database = createDatabaseClient({ connectionString });
    inventoryStore = new RepositoryRegistryStore(database);
    scopeStore = new RepositoryScopeStore(database);
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
    await inventoryStore.synchronize(
      [
        {
          githubRepositoryId: REPOSITORY_ID,
          repositoryFullName: "example/example-service",
          defaultBranch: "main",
          defaultBranchHeadSha: SHA,
          isArchived: false,
        },
      ],
      new Date("2026-07-28T09:00:00.000Z"),
    );
  });

  it("persists a resolved projection and idempotent audit event", async () => {
    const repository = await database.repositoryRegistry.findFirstOrThrow();
    const resolution = resolvedScope();
    const refreshedAt = new Date("2026-07-28T10:00:00.000Z");

    await scopeStore.applyResolution(
      repository.id,
      repository.repositoryFullName,
      resolution,
      refreshedAt,
    );
    await scopeStore.applyResolution(
      repository.id,
      repository.repositoryFullName,
      resolution,
      refreshedAt,
    );

    const updated = await database.repositoryRegistry.findUniqueOrThrow({
      where: { id: repository.id },
    });
    assert.equal(updated.roadieScopeStatus, "RESOLVED");
    assert.equal(updated.componentRef, "component:default/example-service");
    assert.equal(updated.systemRef, "system:default/example-system");
    assert.equal(updated.ownerRef, "group:default/example-team");
    assert.equal(updated.slackChannelId, "C0123456789");
    assert.equal(updated.catalogRevision, "revision-1");
    assert.equal(updated.configurationHash, "a".repeat(64));
    assert.deepEqual(updated.documentationScope, resolution.scope.documents);
    assert.deepEqual(updated.roadieDiagnostics, []);
    assert.deepEqual(updated.lastRoadieRefreshAt, refreshedAt);
    assert.equal(await database.auditEvent.count(), 1);
  });

  it("clears stale trusted metadata when resolution becomes repo-only", async () => {
    const repository = await database.repositoryRegistry.findFirstOrThrow();
    await scopeStore.applyResolution(
      repository.id,
      repository.repositoryFullName,
      resolvedScope(),
      new Date("2026-07-28T10:00:00.000Z"),
    );
    const repoOnly: RoadieScopeResolution = {
      status: "repo-only",
      diagnostics: [
        {
          code: "OWNERSHIP_MISMATCH",
          severity: "error",
          message: "Component and System ownership differ.",
        },
      ],
    };

    await scopeStore.applyResolution(
      repository.id,
      repository.repositoryFullName,
      repoOnly,
      new Date("2026-07-28T11:00:00.000Z"),
    );

    const updated = await database.repositoryRegistry.findUniqueOrThrow({
      where: { id: repository.id },
    });
    assert.equal(updated.roadieScopeStatus, "REPO_ONLY");
    assert.equal(updated.componentRef, null);
    assert.equal(updated.systemRef, null);
    assert.equal(updated.ownerRef, null);
    assert.equal(updated.slackChannelId, null);
    assert.equal(updated.documentationScope, null);
    assert.equal(updated.catalogRevision, null);
    assert.equal(updated.configurationHash, null);
    assert.deepEqual(updated.roadieDiagnostics, repoOnly.diagnostics);
  });

  it("rejects a write when repository identity changed during resolution", async () => {
    const repository = await database.repositoryRegistry.findFirstOrThrow();
    await database.repositoryRegistry.update({
      where: { id: repository.id },
      data: { repositoryFullName: "example/renamed-service" },
    });

    await assert.rejects(
      scopeStore.applyResolution(
        repository.id,
        "example/example-service",
        resolvedScope(),
        new Date("2026-07-28T10:00:00.000Z"),
      ),
      (error: unknown) => error instanceof RepositoryScopeBaselineError,
    );
    assert.equal(await database.auditEvent.count(), 0);
  });
});

function resolvedScope(): RoadieScopeResolution & { status: "resolved" } {
  return {
    status: "resolved",
    scope: {
      repositoryFullName: "example/example-service",
      componentRef: "component:default/example-service",
      systemRef: "system:default/example-system",
      ownerRef: "group:default/example-team",
      slackChannelId: "C0123456789",
      catalogRevision: "revision-1",
      configurationHash: "a".repeat(64),
      documents: [
        {
          siteId: "example-site",
          pageId: "11111",
          declarations: [
            {
              kind: "exact",
              excludedPageIds: [],
              provenance: {
                entityRef: "group:default/example-team",
                title: "Handbook",
                url:
                  "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/11111",
              },
            },
          ],
        },
      ],
    },
    diagnostics: [],
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
