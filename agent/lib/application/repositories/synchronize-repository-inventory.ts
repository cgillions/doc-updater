import type { RepositoryInventoryEntry } from "../../domain/repositories/repository-inventory.ts";

/** Result of reconciling one complete repository inventory. */
export interface RepositoryInventorySyncResult {
  accessibleRepositoryCount: number;
  inaccessibleRepositoryCount: number;
}

/** Supplies one complete repository inventory or rejects without a snapshot. */
export interface RepositoryInventorySource {
  listInstallationRepositories(): Promise<RepositoryInventoryEntry[]>;
}

/** Persists a complete repository inventory atomically. */
export interface RepositoryInventoryRegistry {
  synchronize(
    repositories: readonly RepositoryInventoryEntry[],
    refreshedAt: Date,
  ): Promise<RepositoryInventorySyncResult>;
}

/**
 * Coordinates read-only GitHub inventory collection and registry persistence.
 *
 * Persistence begins only after the source has returned a complete snapshot,
 * so a pagination or branch-head failure cannot revoke repository access.
 */
export class RepositoryInventorySynchronizer {
  private readonly source: RepositoryInventorySource;
  private readonly registry: RepositoryInventoryRegistry;

  constructor(
    source: RepositoryInventorySource,
    registry: RepositoryInventoryRegistry,
  ) {
    this.source = source;
    this.registry = registry;
  }

  /**
   * Reads and atomically persists one complete inventory.
   *
   * @returns Counts of accessible and inaccessible registry entries.
   */
  async synchronize(
    refreshedAt: Date = new Date(),
  ): Promise<RepositoryInventorySyncResult> {
    const repositories =
      await this.source.listInstallationRepositories();
    return this.registry.synchronize(repositories, refreshedAt);
  }
}
