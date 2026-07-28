import type { Prisma, PrismaClient } from "./generated/client.ts";

import { z } from "zod";

import type {
  RepositoryPullRequestArtifactStore,
  RepositoryPullRequestProposal,
} from "../application/repositories/create-repository-pull-request.ts";
import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import {
  buildChangeProposalDigest,
  changeProposalInputSchema,
  repositoryPullRequestRecordSchema,
  type RepositoryPullRequestRecord,
} from "../domain/reviews/review-records.ts";
import { loadReviewRecordJob } from "./review-record-helpers.ts";

const pullRequestArtifactDetailsSchema = repositoryPullRequestRecordSchema.extend({
  proposalId: z.uuid(),
  approvalOutcome: z.literal("approved"),
  sessionId: z.string().min(1).nullable(),
  toolCallId: z.string().min(1).nullable(),
});

/**
 * Loads verified repository proposals and persists created pull-request audit
 * artifacts under their stable idempotency key.
 */
export class RepositoryPullRequestStore
  implements RepositoryPullRequestArtifactStore
{
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Loads one digest-verified proposal scoped to the trusted review job.
   *
   * The proposal remains usable after a durable approval pause even if its
   * review-job lease expires; the GitHub writer independently rejects a moved
   * default branch before creating an artifact.
   */
  async loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<RepositoryPullRequestProposal | null> {
    return this.database.$transaction(async (transaction) => {
      const job = await loadReviewRecordJob(transaction, reviewJobId);
      if (!job.repositoryIsEligible || !job.roadieScopeIsResolved) {
        return null;
      }
      const proposal = await transaction.changeProposal.findFirst({
        where: {
          reviewJobId: job.id,
          digest: proposalDigest,
          targetKind: "REPOSITORY",
        },
        include: { evidenceLinks: true },
      });
      if (!proposal) {
        return null;
      }

      const parsed = changeProposalInputSchema.parse({
        target: proposal.target,
        patch: proposal.patch,
        evidenceClaimIds: proposal.evidenceLinks.map(
          ({ evidenceClaimId }) => evidenceClaimId,
        ),
      });
      if (
        parsed.target.kind !== "repository" ||
        parsed.patch.kind !== "repository-file-replacement" ||
        proposal.repositoryBaselineSha !== job.headSha ||
        proposal.digest !== buildChangeProposalDigest(job.id, job.headSha, parsed)
      ) {
        throw new ReviewRecordConflictError(
          "Repository pull-request proposal digest or baseline is invalid.",
        );
      }

      return {
        id: proposal.id,
        reviewJobId: job.id,
        repositoryId: job.repositoryId,
        repositoryFullName: job.repositoryFullName,
        defaultBranch: job.defaultBranch,
        digest: proposal.digest,
        baseSha: proposal.repositoryBaselineSha,
        path: parsed.target.path,
        content: parsed.patch.content,
      };
    });
  }

  /** Loads a previously recorded artifact for the stable idempotency key. */
  async findCreated(
    idempotencyKey: string,
  ): Promise<RepositoryPullRequestRecord | null> {
    const event = await this.database.auditEvent.findUnique({
      where: { idempotencyKey },
    });
    if (!event) {
      return null;
    }
    if (event.eventType !== "repository_pull_request_created") {
      throw new ReviewRecordConflictError(
        "Repository pull-request idempotency key belongs to another audit event.",
      );
    }
    return toArtifactRecord(event.details);
  }

  /**
   * Writes the immutable audit artifact, returning an existing exact replay.
   */
  async recordCreated(input: {
    proposal: RepositoryPullRequestProposal;
    idempotencyKey: string;
    branchName: string;
    commitSha: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<RepositoryPullRequestRecord> {
    const record = repositoryPullRequestRecordSchema.parse({
      proposalDigest: input.proposal.digest,
      baseSha: input.proposal.baseSha,
      branchName: input.branchName,
      commitSha: input.commitSha,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
    });
    try {
      await this.database.auditEvent.create({
        data: {
          repositoryId: input.proposal.repositoryId,
          reviewJobId: input.proposal.reviewJobId,
          eventType: "repository_pull_request_created",
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          details: {
            proposalId: input.proposal.id,
            approvalOutcome: "approved",
            sessionId: input.sessionId ?? null,
            toolCallId: input.toolCallId ?? null,
            ...record,
          } as Prisma.InputJsonValue,
        },
      });
      return record;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const replay = await this.findCreated(input.idempotencyKey);
      if (!replay) {
        throw error;
      }
      if (
        replay.proposalDigest !== record.proposalDigest ||
        replay.baseSha !== record.baseSha ||
        replay.branchName !== record.branchName ||
        replay.commitSha !== record.commitSha ||
        replay.pullRequestNumber !== record.pullRequestNumber ||
        replay.pullRequestUrl !== record.pullRequestUrl
      ) {
        throw new ReviewRecordConflictError(
          "Repository pull-request idempotency key was replayed with a different artifact.",
        );
      }
      return replay;
    }
  }
}

function toArtifactRecord(details: unknown): RepositoryPullRequestRecord {
  const parsed = pullRequestArtifactDetailsSchema.parse(details);
  return repositoryPullRequestRecordSchema.parse(parsed);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
