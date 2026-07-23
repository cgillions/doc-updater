import { Prisma, type PrismaClient } from "./generated/client.ts";

import type { RepositoryInventoryEntry } from "../domain/repositories/repository-inventory.ts";

/** Summary of the registry state after an inventory reconciliation. */
export interface RepositoryRegistrySyncResult {
  accessibleRepositoryCount: number;
  inaccessibleRepositoryCount: number;
}

/**
 * Reconciles complete GitHub App inventory snapshots into PostgreSQL.
 *
 * Repositories are matched by immutable GitHub ID. Entries absent from a
 * complete snapshot are retained but marked inaccessible.
 */
export class RepositoryRegistryStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Applies one complete inventory snapshot atomically.
   *
   * Older snapshots cannot overwrite repository state written by a newer
   * refresh. Administrative pause state, scheduling state, and history are
   * preserved.
   *
   * @returns Counts of currently accessible and inaccessible repositories.
   */
  async synchronize(
    repositories: RepositoryInventoryEntry[],
    refreshedAt: Date = new Date(),
  ): Promise<RepositoryRegistrySyncResult> {
    validateSnapshot(repositories, refreshedAt);
    const inventoryJson = JSON.stringify(
      repositories.map((repository) => ({
        github_repository_id: repository.githubRepositoryId,
        repository_full_name: repository.repositoryFullName,
        default_branch: repository.defaultBranch,
        default_branch_head_sha: repository.defaultBranchHeadSha,
        is_archived: repository.isArchived,
      })),
    );
    const repositoryIdsJson = JSON.stringify(
      repositories.map((repository) => repository.githubRepositoryId),
    );

    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO repository_registry (
          id,
          github_repository_id,
          repository_full_name,
          default_branch,
          default_branch_head_sha,
          is_accessible,
          is_archived,
          last_inventory_refresh_at,
          created_at,
          updated_at
        )
        SELECT
          gen_random_uuid(),
          inventory.github_repository_id,
          inventory.repository_full_name,
          inventory.default_branch,
          inventory.default_branch_head_sha,
          true,
          inventory.is_archived,
          ${refreshedAt},
          ${refreshedAt},
          ${refreshedAt}
        FROM jsonb_to_recordset(${inventoryJson}::jsonb) AS inventory(
          github_repository_id text,
          repository_full_name text,
          default_branch text,
          default_branch_head_sha text,
          is_archived boolean
        )
        ON CONFLICT (github_repository_id)
        DO UPDATE SET
          repository_full_name = EXCLUDED.repository_full_name,
          default_branch = EXCLUDED.default_branch,
          default_branch_head_sha = EXCLUDED.default_branch_head_sha,
          is_accessible = true,
          is_archived = EXCLUDED.is_archived,
          last_inventory_refresh_at = EXCLUDED.last_inventory_refresh_at,
          updated_at = EXCLUDED.updated_at
        WHERE repository_registry.last_inventory_refresh_at
          <= EXCLUDED.last_inventory_refresh_at
      `);

      await transaction.$executeRaw(Prisma.sql`
        UPDATE repository_registry
        SET is_accessible = false,
            last_inventory_refresh_at = ${refreshedAt},
            updated_at = ${refreshedAt}
        WHERE is_accessible = true
          AND last_inventory_refresh_at <= ${refreshedAt}
          AND github_repository_id NOT IN (
            SELECT jsonb_array_elements_text(${repositoryIdsJson}::jsonb)
          )
      `);

      return {
        accessibleRepositoryCount: await transaction.repositoryRegistry.count({
          where: { isAccessible: true },
        }),
        inaccessibleRepositoryCount:
          await transaction.repositoryRegistry.count({
            where: { isAccessible: false },
          }),
      };
    });
  }
}

function validateSnapshot(
  repositories: RepositoryInventoryEntry[],
  refreshedAt: Date,
): void {
  if (Number.isNaN(refreshedAt.getTime())) {
    throw new RangeError("Repository inventory refresh time must be valid.");
  }

  const repositoryIds = new Set<string>();
  const repositoryNames = new Set<string>();
  for (const repository of repositories) {
    if (!/^\d+$/.test(repository.githubRepositoryId)) {
      throw new Error("GitHub repository ID must contain only digits.");
    }
    if (repositoryIds.has(repository.githubRepositoryId)) {
      throw new Error(
        `Inventory contains repository ID ${repository.githubRepositoryId} more than once.`,
      );
    }
    repositoryIds.add(repository.githubRepositoryId);

    const normalizedName = repository.repositoryFullName.toLowerCase();
    if (!/^[^/]+\/[^/]+$/.test(repository.repositoryFullName)) {
      throw new Error(
        `GitHub repository name ${repository.repositoryFullName} is invalid.`,
      );
    }
    if (repositoryNames.has(normalizedName)) {
      throw new Error(
        `Inventory contains repository name ${repository.repositoryFullName} more than once.`,
      );
    }
    repositoryNames.add(normalizedName);

    if (repository.defaultBranch.length === 0) {
      throw new Error("GitHub default branch must not be empty.");
    }
    if (
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(
        repository.defaultBranchHeadSha,
      )
    ) {
      throw new Error("GitHub default branch head must be a 40 or 64 character SHA.");
    }
  }
}
