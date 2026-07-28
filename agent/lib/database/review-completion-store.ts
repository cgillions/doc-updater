import type {
  Prisma,
  PrismaClient,
  ReviewJobOutcome,
} from "./generated/client.ts";

import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import {
  completedReviewJobSchema,
  completeReviewJobInputSchema,
  type CompletedReviewJob,
  type CompleteReviewJobInput,
} from "../domain/reviews/review-records.ts";
import {
  loadReviewRecordJob,
  requireActiveReviewJob,
} from "./review-record-helpers.ts";

const outcomeToDatabase = {
  "no-change": "NO_CHANGE",
  "in-sync": "IN_SYNC",
  "proposal-created": "PROPOSAL_CREATED",
  incomplete: "INCOMPLETE",
} as const satisfies Record<
  CompleteReviewJobInput["outcome"],
  ReviewJobOutcome
>;

const outcomeFromDatabase = {
  NO_CHANGE: "no-change",
  IN_SYNC: "in-sync",
  PROPOSAL_CREATED: "proposal-created",
  INCOMPLETE: "incomplete",
} as const satisfies Record<
  ReviewJobOutcome,
  CompleteReviewJobInput["outcome"]
>;

/** Atomically records review outcomes and advances successful cursors. */
export class ReviewCompletionStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Completes a leased job after validating its persisted evidence.
   *
   * `incomplete` is terminal but deliberately leaves the repository cursor
   * unchanged. Exact replays return the existing result.
   *
   * @returns The terminal outcome and whether its cursor advanced.
   */
  async complete(
    reviewJobId: string,
    input: CompleteReviewJobInput,
    completedAt: Date = new Date(),
  ): Promise<CompletedReviewJob> {
    const parsed = completeReviewJobInputSchema.parse(input);
    return this.database.$transaction(async (transaction) => {
      const job = await loadReviewRecordJob(transaction, reviewJobId);
      if (job.status === "COMPLETED" && job.outcome) {
        return completedReplay(job, parsed);
      }

      requireActiveReviewJob(job, completedAt);
      if (!job.leaseToken) {
        throw new ReviewRecordConflictError(
          "The assigned review job has no active lease token.",
        );
      }
      const evidenceCount = await transaction.evidenceClaim.count({
        where: { reviewJobId: job.id },
      });
      if (parsed.outcome !== "incomplete" && evidenceCount === 0) {
        throw new ReviewRecordConflictError(
          "A successful review requires persisted implementation evidence before completion.",
        );
      }
      if (parsed.outcome === "proposal-created") {
        const proposalCount = await transaction.changeProposal.count({
          where: { reviewJobId: job.id },
        });
        if (proposalCount === 0) {
          throw new ReviewRecordConflictError(
            "A proposal-created outcome requires a persisted proposal.",
          );
        }
      }

      const cursorAdvanced = parsed.outcome !== "incomplete";
      if (cursorAdvanced) {
        await advanceCursor(
          transaction,
          job.repositoryId,
          job.baseSha,
          job.headSha,
          completedAt,
        );
      }
      await transaction.reviewJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          leaseOwner: null,
          leaseToken: null,
          lastLeaseToken: job.leaseToken,
          lastLeaseOutcome: "COMPLETED",
          leaseExpiresAt: null,
          completedAt,
          failedAt: null,
          lastFailureCode: null,
          lastFailureMessage: null,
          outcome: outcomeToDatabase[parsed.outcome],
          outcomeSummary: parsed.summary,
          cursorAdvancedAt: cursorAdvanced ? completedAt : null,
        },
      });
      await transaction.auditEvent.upsert({
        where: {
          idempotencyKey: `review-job-outcome:${job.id}`,
        },
        create: {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          eventType: "review_job_outcome_recorded",
          idempotencyKey: `review-job-outcome:${job.id}`,
          details: {
            outcome: parsed.outcome,
            headSha: job.headSha,
            cursorAdvanced,
          },
        },
        update: {},
      });
      return completedReviewJobSchema.parse({
        reviewJobId: job.id,
        headSha: job.headSha,
        outcome: parsed.outcome,
        summary: parsed.summary,
        completedAt: completedAt.toISOString(),
        cursorAdvanced,
      });
    });
  }
}

async function advanceCursor(
  transaction: Prisma.TransactionClient,
  repositoryId: string,
  expectedBaseSha: string | null,
  headSha: string,
  completedAt: Date,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT id
    FROM repository_registry
    WHERE id = ${repositoryId}::uuid
    FOR UPDATE
  `;
  const cursor = await transaction.repositoryCursor.findUnique({
    where: { repositoryId },
  });
  const cursorSha = cursor?.lastSuccessfullyReviewedSha ?? null;
  if (cursorSha !== expectedBaseSha && cursorSha !== headSha) {
    throw new ReviewRecordConflictError(
      "The repository cursor changed after this review job was created.",
    );
  }
  await transaction.repositoryCursor.upsert({
    where: { repositoryId },
    create: {
      repositoryId,
      lastSuccessfullyReviewedSha: headSha,
      lastSuccessfullyReviewedAt: completedAt,
    },
    update: {
      lastSuccessfullyReviewedSha: headSha,
      lastSuccessfullyReviewedAt: completedAt,
    },
  });
}

function completedReplay(
  job: {
    id: string;
    headSha: string;
    outcome: string | null;
    outcomeSummary: string | null;
    completedAt: Date | null;
    cursorAdvancedAt: Date | null;
  },
  input: CompleteReviewJobInput,
): CompletedReviewJob {
  const storedOutcome =
    job.outcome && job.outcome in outcomeFromDatabase
      ? outcomeFromDatabase[job.outcome as ReviewJobOutcome]
      : null;
  if (
    storedOutcome !== input.outcome ||
    job.outcomeSummary !== input.summary ||
    !job.completedAt
  ) {
    throw new ReviewRecordConflictError(
      "The review job was already completed with a different outcome.",
    );
  }
  return completedReviewJobSchema.parse({
    reviewJobId: job.id,
    headSha: job.headSha,
    outcome: storedOutcome,
    summary: job.outcomeSummary,
    completedAt: job.completedAt.toISOString(),
    cursorAdvanced: job.cursorAdvancedAt !== null,
  });
}
