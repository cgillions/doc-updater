import type { Prisma, PrismaClient } from "./generated/client.ts";

import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import {
  buildChangeProposalDigest,
  changeProposalInputSchema,
  changeProposalRecordSchema,
  type ChangeProposalInput,
  type ChangeProposalRecord,
} from "../domain/reviews/review-records.ts";
import {
  loadReviewRecordJob,
  requireActiveReviewJob,
  requireConfluenceTarget,
} from "./review-record-helpers.ts";

/** Persists immutable, evidence-backed proposals for assigned targets. */
export class ChangeProposalStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Creates one baseline-bound proposal inside the assigned job scope.
   *
   * @returns The new proposal, or its existing record on an exact replay.
   */
  async create(
    reviewJobId: string,
    input: ChangeProposalInput,
    now: Date = new Date(),
  ): Promise<ChangeProposalRecord> {
    const parsed = changeProposalInputSchema.parse(input);
    return this.database.$transaction(async (transaction) => {
      const job = await loadReviewRecordJob(transaction, reviewJobId);
      const digest = buildChangeProposalDigest(
        job.id,
        job.headSha,
        parsed,
      );
      const existing = await transaction.changeProposal.findUnique({
        where: { digest },
        include: { evidenceLinks: true },
      });
      if (existing) {
        return toChangeProposalRecord(existing);
      }

      requireActiveReviewJob(job, now);
      if (parsed.target.kind === "confluence") {
        requireConfluenceTarget(
          job,
          parsed.target.siteId,
          parsed.target.pageId,
        );
      }
      const evidence = await transaction.evidenceClaim.findMany({
        where: {
          id: { in: parsed.evidenceClaimIds },
          reviewJobId: job.id,
        },
        select: {
          id: true,
          targetKind: true,
          documentation: true,
        },
      });
      if (evidence.length !== parsed.evidenceClaimIds.length) {
        throw new ReviewRecordConflictError(
          "Every proposal evidence claim must belong to the assigned job.",
        );
      }
      if (parsed.target.kind === "confluence") {
        const target = parsed.target;
        if (
          !evidence.some(({ targetKind, documentation }) =>
            targetKind === "CONFLUENCE" &&
            isMatchingConfluenceBaseline(documentation, target),
          )
        ) {
          throw new ReviewRecordConflictError(
            "A Confluence proposal requires evidence for its exact page baseline.",
          );
        }
      }

      const proposal = await transaction.changeProposal.create({
        data: {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          digest,
          targetKind:
            parsed.target.kind === "repository"
              ? "REPOSITORY"
              : "CONFLUENCE",
          target: parsed.target as Prisma.InputJsonValue,
          repositoryBaselineSha:
            parsed.target.kind === "repository" ? job.headSha : null,
          patch: parsed.patch as Prisma.InputJsonValue,
          createdAt: now,
          evidenceLinks: {
            create: parsed.evidenceClaimIds.map((evidenceClaimId) => ({
              evidenceClaimId,
            })),
          },
        },
        include: { evidenceLinks: true },
      });
      await transaction.auditEvent.create({
        data: {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          eventType: "change_proposal_created",
          idempotencyKey: `change-proposal:${digest}`,
          details: {
            changeProposalId: proposal.id,
            digest,
            targetKind: proposal.targetKind,
          },
        },
      });
      return toChangeProposalRecord(proposal);
    });
  }
}

function isMatchingConfluenceBaseline(
  documentation: unknown,
  target: {
    siteId: string;
    pageId: string;
    version: number;
    bodyHash: string;
  },
): boolean {
  if (typeof documentation !== "object" || documentation === null) {
    return false;
  }
  const value = documentation as Record<string, unknown>;
  return (
    value.kind === "confluence" &&
    value.siteId === target.siteId &&
    value.pageId === target.pageId &&
    value.version === target.version &&
    value.bodyHash === target.bodyHash
  );
}

function toChangeProposalRecord(proposal: {
  id: string;
  reviewJobId: string;
  digest: string;
  target: unknown;
  repositoryBaselineSha: string | null;
  patch: unknown;
  evidenceLinks: Array<{ evidenceClaimId: string }>;
}): ChangeProposalRecord {
  return changeProposalRecordSchema.parse({
    id: proposal.id,
    reviewJobId: proposal.reviewJobId,
    digest: proposal.digest,
    target: proposal.target,
    repositoryBaselineSha: proposal.repositoryBaselineSha,
    patch: proposal.patch,
    evidenceClaimIds: proposal.evidenceLinks
      .map(({ evidenceClaimId }) => evidenceClaimId)
      .sort(),
  });
}
