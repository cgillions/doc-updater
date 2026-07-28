import type { Prisma } from "./generated/client.ts";

import { documentationScopeSchema } from "../domain/review-jobs/review-job-context.ts";
import {
  ReviewRecordConflictError,
  ReviewRecordUnavailableError,
} from "../domain/reviews/errors.ts";

/** Database state required to bind a record to one assigned review job. */
export interface ReviewRecordJob {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  headSha: string;
  baseSha: string | null;
  status: string;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  outcome: string | null;
  outcomeSummary: string | null;
  completedAt: Date | null;
  cursorAdvancedAt: Date | null;
  repositoryIsEligible: boolean;
  roadieScopeIsResolved: boolean;
  documentationScope: ReturnType<
    typeof documentationScopeSchema.parse
  >;
}

/**
 * Locks and loads a review job with its current trusted documentation scope.
 *
 * Callers may replay an existing immutable record after completion, but must
 * call `requireActiveReviewJob` before creating a new record.
 *
 * @returns The locked job and validated canonical Confluence scope.
 */
export async function loadReviewRecordJob(
  transaction: Prisma.TransactionClient,
  reviewJobId: string,
): Promise<ReviewRecordJob> {
  await transaction.$queryRaw`
    SELECT id
    FROM review_jobs
    WHERE id = ${reviewJobId}::uuid
    FOR UPDATE
  `;
  const job = await transaction.reviewJob.findUnique({
    where: { id: reviewJobId },
    select: {
      id: true,
      repositoryId: true,
      headSha: true,
      baseSha: true,
      status: true,
      leaseToken: true,
      leaseExpiresAt: true,
      outcome: true,
      outcomeSummary: true,
      completedAt: true,
      cursorAdvancedAt: true,
      repository: {
        select: {
          repositoryFullName: true,
          defaultBranch: true,
          isAccessible: true,
          isArchived: true,
          isPaused: true,
          roadieScopeStatus: true,
          documentationScope: true,
        },
      },
    },
  });
  if (!job) {
    throw new ReviewRecordUnavailableError(reviewJobId);
  }
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    repositoryFullName: job.repository.repositoryFullName,
    defaultBranch: job.repository.defaultBranch,
    headSha: job.headSha,
    baseSha: job.baseSha,
    status: job.status,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
    outcome: job.outcome,
    outcomeSummary: job.outcomeSummary,
    completedAt: job.completedAt,
    cursorAdvancedAt: job.cursorAdvancedAt,
    repositoryIsEligible:
      job.repository.isAccessible &&
      !job.repository.isArchived &&
      !job.repository.isPaused,
    roadieScopeIsResolved:
      job.repository.roadieScopeStatus === "RESOLVED",
    documentationScope: documentationScopeSchema.parse(
      job.repository.documentationScope ?? [],
    ),
  };
}

/** Rejects creation when a job no longer owns a valid active lease. */
export function requireActiveReviewJob(
  job: ReviewRecordJob,
  now: Date,
): void {
  if (
    job.status !== "LEASED" ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt <= now ||
    !job.repositoryIsEligible ||
    !job.roadieScopeIsResolved
  ) {
    throw new ReviewRecordUnavailableError(job.id);
  }
}

/** Ensures a Confluence target belongs to the assigned canonical scope. */
export function requireConfluenceTarget(
  job: ReviewRecordJob,
  siteId: string,
  pageId: string,
): void {
  if (
    !job.documentationScope.some(
      (target) =>
        target.siteId === siteId && target.pageId === pageId,
    )
  ) {
    throw new ReviewRecordConflictError(
      `Confluence page ${siteId}/${pageId} is outside the assigned job scope.`,
    );
  }
}
