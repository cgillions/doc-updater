import { Prisma, type PrismaClient } from "./generated/client.ts";

import type { RepositoryInventorySyncResult } from "../application/repositories/synchronize-repository-inventory.ts";
import type { RepositoryInventoryEntry } from "../domain/repositories/repository-inventory.ts";

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
    repositories: readonly RepositoryInventoryEntry[],
    refreshedAt: Date = new Date(),
  ): Promise<RepositoryInventorySyncResult> {
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
          roadie_scope_status = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN 'PENDING'::"RoadieScopeStatus"
            ELSE repository_registry.roadie_scope_status
          END,
          component_ref = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.component_ref
          END,
          system_ref = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.system_ref
          END,
          owner_ref = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.owner_ref
          END,
          slack_channel_id = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.slack_channel_id
          END,
          documentation_scope = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.documentation_scope
          END,
          catalog_revision = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.catalog_revision
          END,
          configuration_hash = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.configuration_hash
          END,
          roadie_diagnostics = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN '[]'::jsonb
            ELSE repository_registry.roadie_diagnostics
          END,
          last_roadie_refresh_at = CASE
            WHEN repository_registry.repository_full_name
              IS DISTINCT FROM EXCLUDED.repository_full_name
              THEN NULL
            ELSE repository_registry.last_roadie_refresh_at
          END,
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
  repositories: readonly RepositoryInventoryEntry[],
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
