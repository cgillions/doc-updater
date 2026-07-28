import type { DueReviewCandidate } from "../application/review-jobs/enqueue-due-reviews.ts";
import { Prisma, type PrismaClient } from "./generated/client.ts";

/** Database row shape returned by due-review candidate selection. */
interface DueReviewCandidateRow {
  repositoryId: string;
  baseSha: string | null;
  headSha: string;
  mode: "INCREMENTAL" | "RECONCILIATION";
}

/**
 * Reads deterministic review inputs from the materialized repository registry.
 *
 * Only repositories with a trusted Roadie route are eligible for Slack
 * dispatch. A missing successful cursor creates a reconciliation baseline.
 */
export class RepositoryReviewStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Lists changed, schedulable repositories and their immutable SHA ranges.
   *
   * @returns Incremental candidates for existing cursors and reconciliation
   * candidates where no successful baseline exists.
   */
  async listDueReviewCandidates(): Promise<DueReviewCandidate[]> {
    return this.database.$queryRaw<DueReviewCandidateRow[]>(Prisma.sql`
      SELECT
        repositories.id AS "repositoryId",
        cursors.last_successfully_reviewed_sha AS "baseSha",
        repositories.default_branch_head_sha AS "headSha",
        CASE
          WHEN cursors.last_successfully_reviewed_sha IS NULL
            THEN 'RECONCILIATION'::"ReviewJobMode"
          ELSE 'INCREMENTAL'::"ReviewJobMode"
        END AS "mode"
      FROM repository_registry AS repositories
      LEFT JOIN repository_cursors AS cursors
        ON cursors.repository_id = repositories.id
      WHERE repositories.is_accessible = true
        AND repositories.is_archived = false
        AND repositories.is_paused = false
        AND repositories.roadie_scope_status = 'RESOLVED'::"RoadieScopeStatus"
        AND repositories.slack_channel_id IS NOT NULL
        AND (
          cursors.last_successfully_reviewed_sha IS NULL
          OR cursors.last_successfully_reviewed_sha
            <> repositories.default_branch_head_sha
        )
      ORDER BY repositories.github_repository_id
    `);
  }
}
