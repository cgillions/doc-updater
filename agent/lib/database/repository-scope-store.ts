import { createHash } from "node:crypto";

import type { RoadieRefreshCandidate } from "../application/repositories/refresh-control-plane.ts";
import type { RepositoryRoadieResolutionTarget } from "../application/repositories/synchronize-roadie-scope.ts";
import type { RoadieScopeResolution } from "../domain/documentation/documentation-scope.ts";
import { Prisma, type PrismaClient } from "./generated/client.ts";

/** Raised when repository identity changes while Roadie is being resolved. */
export class RepositoryScopeBaselineError extends Error {
  constructor(repositoryId: string) {
    super(
      `Repository ${repositoryId} changed while its Roadie scope was resolved.`,
    );
    this.name = "RepositoryScopeBaselineError";
  }
}

/**
 * Persists the materialized Roadie projection for repository scheduling.
 *
 * Roadie remains the configuration source. Invalid resolution clears any
 * previously trusted routing and documentation scope.
 */
export class RepositoryScopeStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Reads the repository identity used as a resolution baseline.
   *
   * @returns The current identity, or `null` when the entry does not exist.
   */
  async getResolutionTarget(
    repositoryId: string,
  ): Promise<RepositoryRoadieResolutionTarget | null> {
    return this.database.repositoryRegistry.findUnique({
      where: { id: repositoryId },
      select: { id: true, repositoryFullName: true },
    });
  }

  /**
   * Selects a bounded refresh batch, prioritizing never-resolved entries.
   */
  async listRoadieRefreshCandidates(input: {
    limit: number;
    staleBefore: Date;
  }): Promise<RoadieRefreshCandidate[]> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new RangeError(
        "Roadie refresh limit must be between 1 and 100.",
      );
    }
    if (Number.isNaN(input.staleBefore.getTime())) {
      throw new RangeError("Roadie stale boundary must be valid.");
    }

    return this.database.$queryRaw<RoadieRefreshCandidate[]>(Prisma.sql`
      SELECT id AS "repositoryId"
      FROM repository_registry
      WHERE is_accessible = true
        AND is_archived = false
        AND is_paused = false
        AND (
          roadie_scope_status = 'PENDING'::"RoadieScopeStatus"
          OR last_roadie_refresh_at IS NULL
          OR last_roadie_refresh_at < ${input.staleBefore}
        )
      ORDER BY
        CASE roadie_scope_status
          WHEN 'PENDING'::"RoadieScopeStatus" THEN 0
          WHEN 'REPO_ONLY'::"RoadieScopeStatus" THEN 1
          ELSE 2
        END,
        last_roadie_refresh_at ASC NULLS FIRST,
        github_repository_id
      LIMIT ${input.limit}
    `);
  }

  /**
   * Atomically materializes a resolved or fail-closed Roadie result.
   *
   * Replaying the same result updates freshness while retaining one audit
   * event. A changed repository name rejects the complete transaction.
   */
  async applyResolution(
    repositoryId: string,
    expectedRepositoryFullName: string,
    resolution: RoadieScopeResolution,
    refreshedAt: Date,
  ): Promise<void> {
    if (Number.isNaN(refreshedAt.getTime())) {
      throw new RangeError("Roadie scope refresh time must be valid.");
    }
    if (
      resolution.status === "resolved" &&
      resolution.scope.repositoryFullName !== expectedRepositoryFullName
    ) {
      throw new RepositoryScopeBaselineError(repositoryId);
    }

    await this.database.$transaction(async (transaction) => {
      const update = await transaction.repositoryRegistry.updateMany({
        where: {
          id: repositoryId,
          repositoryFullName: expectedRepositoryFullName,
        },
        data: projectionData(resolution, refreshedAt),
      });
      if (update.count !== 1) {
        throw new RepositoryScopeBaselineError(repositoryId);
      }

      await transaction.auditEvent.createMany({
        data: [
          {
            repositoryId,
            eventType:
              resolution.status === "resolved"
                ? "roadie_scope_resolved"
                : "roadie_scope_repo_only",
            idempotencyKey:
              `roadie-scope:${repositoryId}:` +
              resolutionDigest(resolution),
            actorId: "roadie-control-plane",
            details: auditDetails(resolution),
            createdAt: refreshedAt,
          },
        ],
        skipDuplicates: true,
      });
    });
  }
}

function projectionData(
  resolution: RoadieScopeResolution,
  refreshedAt: Date,
): Prisma.RepositoryRegistryUpdateManyMutationInput {
  const diagnostics = resolution.diagnostics as unknown as Prisma.InputJsonValue;
  if (resolution.status === "repo-only") {
    return {
      roadieScopeStatus: "REPO_ONLY",
      componentRef: null,
      systemRef: null,
      ownerRef: null,
      slackChannelId: null,
      documentationScope: Prisma.DbNull,
      catalogRevision: null,
      configurationHash: null,
      roadieDiagnostics: diagnostics,
      lastRoadieRefreshAt: refreshedAt,
    };
  }
  return {
    roadieScopeStatus: "RESOLVED",
    componentRef: resolution.scope.componentRef,
    systemRef: resolution.scope.systemRef,
    ownerRef: resolution.scope.ownerRef,
    slackChannelId: resolution.scope.slackChannelId,
    documentationScope:
      resolution.scope.documents as unknown as Prisma.InputJsonValue,
    catalogRevision: resolution.scope.catalogRevision,
    configurationHash: resolution.scope.configurationHash,
    roadieDiagnostics: diagnostics,
    lastRoadieRefreshAt: refreshedAt,
  };
}

function auditDetails(
  resolution: RoadieScopeResolution,
): Prisma.InputJsonValue {
  if (resolution.status === "repo-only") {
    return {
      status: resolution.status,
      diagnosticCodes: resolution.diagnostics.map(({ code }) => code),
    };
  }
  return {
    status: resolution.status,
    componentRef: resolution.scope.componentRef,
    systemRef: resolution.scope.systemRef,
    ownerRef: resolution.scope.ownerRef,
    catalogRevision: resolution.scope.catalogRevision,
    configurationHash: resolution.scope.configurationHash,
    diagnosticCodes: resolution.diagnostics.map(({ code }) => code),
  };
}

function resolutionDigest(resolution: RoadieScopeResolution): string {
  if (resolution.status === "resolved") {
    return resolution.scope.configurationHash;
  }
  return createHash("sha256")
    .update(JSON.stringify(resolution.diagnostics))
    .digest("hex");
}
