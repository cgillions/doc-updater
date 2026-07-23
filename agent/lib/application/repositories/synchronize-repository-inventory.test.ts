import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RepositoryInventoryEntry } from "../../domain/repositories/repository-inventory.ts";
import {
  RepositoryInventorySynchronizer,
  type RepositoryInventoryRegistry,
  type RepositoryInventorySource,
  type RepositoryInventorySyncResult,
} from "./synchronize-repository-inventory.ts";

const HEAD_SHA = "a".repeat(40);

describe("RepositoryInventorySynchronizer", () => {
  it("persists one complete GitHub inventory snapshot", async () => {
    const refreshedAt = new Date("2026-07-23T11:00:00.000Z");
    const inventory = [repositoryFixture("101", "example/alpha")];
    const registry = new RecordingRegistry({
      accessibleRepositoryCount: 1,
      inaccessibleRepositoryCount: 0,
    });
    const synchronizer = new RepositoryInventorySynchronizer(
      new FixtureInventorySource(inventory),
      registry,
    );

    const result = await synchronizer.synchronize(refreshedAt);

    assert.deepEqual(result, {
      accessibleRepositoryCount: 1,
      inaccessibleRepositoryCount: 0,
    });
    assert.deepEqual(registry.snapshots, [
      { repositories: inventory, refreshedAt },
    ]);
  });

  it("does not reconcile a partial snapshot when GitHub fails", async () => {
    const registry = new RecordingRegistry({
      accessibleRepositoryCount: 0,
      inaccessibleRepositoryCount: 0,
    });
    const source: RepositoryInventorySource = {
      async listInstallationRepositories() {
        throw new Error("GitHub branch-head request failed.");
      },
    };
    const synchronizer = new RepositoryInventorySynchronizer(source, registry);

    await assert.rejects(
      synchronizer.synchronize(new Date("2026-07-23T11:00:00.000Z")),
      /branch-head request failed/,
    );
    assert.deepEqual(registry.snapshots, []);
  });
});

class FixtureInventorySource implements RepositoryInventorySource {
  private readonly repositories: RepositoryInventoryEntry[];

  constructor(repositories: RepositoryInventoryEntry[]) {
    this.repositories = repositories;
  }

  async listInstallationRepositories(): Promise<RepositoryInventoryEntry[]> {
    return this.repositories;
  }
}

class RecordingRegistry implements RepositoryInventoryRegistry {
  readonly snapshots: Array<{
    repositories: readonly RepositoryInventoryEntry[];
    refreshedAt: Date;
  }> = [];

  private readonly result: RepositoryInventorySyncResult;

  constructor(result: RepositoryInventorySyncResult) {
    this.result = result;
  }

  async synchronize(
    repositories: readonly RepositoryInventoryEntry[],
    refreshedAt: Date,
  ): Promise<RepositoryInventorySyncResult> {
    this.snapshots.push({ repositories, refreshedAt });
    return this.result;
  }
}

function repositoryFixture(
  githubRepositoryId: string,
  repositoryFullName: string,
): RepositoryInventoryEntry {
  return {
    githubRepositoryId,
    repositoryFullName,
    defaultBranch: "main",
    defaultBranchHeadSha: HEAD_SHA,
    isArchived: false,
  };
}
