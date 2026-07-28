import type { RoadieScopeResolution } from "../../domain/documentation/documentation-scope.ts";

/** Stable repository identity used as the Roadie resolution baseline. */
export interface RepositoryRoadieResolutionTarget {
  id: string;
  repositoryFullName: string;
}

/** Registry operations needed to materialize a Roadie scope projection. */
export interface RepositoryRoadieScopeRegistry {
  getResolutionTarget(
    repositoryId: string,
  ): Promise<RepositoryRoadieResolutionTarget | null>;
  applyResolution(
    repositoryId: string,
    expectedRepositoryFullName: string,
    resolution: RoadieScopeResolution,
    refreshedAt: Date,
  ): Promise<void>;
}

/** Resolves trusted Roadie metadata for one repository name. */
export interface RepositoryRoadieScopeResolver {
  resolve(repositoryFullName: string): Promise<RoadieScopeResolution>;
}

/**
 * Enriches one registry entry with its current Roadie scope.
 *
 * The persistence write is bound to the repository name read before the
 * Roadie calls, preventing a concurrent GitHub rename from accepting stale
 * catalog metadata.
 */
export class RepositoryRoadieScopeSynchronizer {
  private readonly registry: RepositoryRoadieScopeRegistry;
  private readonly resolver: RepositoryRoadieScopeResolver;

  constructor(
    registry: RepositoryRoadieScopeRegistry,
    resolver: RepositoryRoadieScopeResolver,
  ) {
    this.registry = registry;
    this.resolver = resolver;
  }

  /**
   * Resolves and persists one repository's Roadie projection.
   *
   * @returns The resolved or `repo-only` result that was persisted.
   */
  async synchronize(
    repositoryId: string,
    refreshedAt: Date = new Date(),
  ): Promise<RoadieScopeResolution> {
    const target = await this.registry.getResolutionTarget(repositoryId);
    if (!target) {
      throw new Error(
        `Repository ${repositoryId} is not present in the repository registry.`,
      );
    }
    const resolution = await this.resolver.resolve(
      target.repositoryFullName,
    );
    await this.registry.applyResolution(
      target.id,
      target.repositoryFullName,
      resolution,
      refreshedAt,
    );
    return resolution;
  }
}
