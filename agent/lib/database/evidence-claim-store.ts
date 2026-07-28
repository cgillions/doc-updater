import type { Prisma } from "./generated/client.ts";
import type { PrismaClient } from "./generated/client.ts";

import {
  buildEvidenceClaimDigest,
  evidenceClaimRecordSchema,
  recordDriftEvidenceInputSchema,
  type EvidenceClaimRecord,
  type RecordDriftEvidenceInput,
} from "../domain/reviews/review-records.ts";
import {
  loadReviewRecordJob,
  requireActiveReviewJob,
  requireConfluenceTarget,
} from "./review-record-helpers.ts";

/** Persists immutable implementation-backed claims for one review job. */
export class EvidenceClaimStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Records one claim against the assigned SHA and documentation baseline.
   *
   * @returns The new record, or the existing record when the call is replayed.
   */
  async record(
    reviewJobId: string,
    input: RecordDriftEvidenceInput,
    now: Date = new Date(),
  ): Promise<EvidenceClaimRecord> {
    const parsed = recordDriftEvidenceInputSchema.parse(input);
    return this.database.$transaction(async (transaction) => {
      const job = await loadReviewRecordJob(transaction, reviewJobId);
      const digest = buildEvidenceClaimDigest(
        job.id,
        job.headSha,
        parsed,
      );
      const existing = await transaction.evidenceClaim.findUnique({
        where: { digest },
      });
      if (existing) {
        return toEvidenceClaimRecord(existing);
      }

      requireActiveReviewJob(job, now);
      if (parsed.documentation.kind === "confluence") {
        requireConfluenceTarget(
          job,
          parsed.documentation.siteId,
          parsed.documentation.pageId,
        );
      }

      const claim = await transaction.evidenceClaim.create({
        data: {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          digest,
          claimText: parsed.claim,
          implementationSha: job.headSha,
          implementationReferences:
            parsed.implementationReferences as Prisma.InputJsonValue,
          behaviorComparisons:
            parsed.behaviorComparisons as Prisma.InputJsonValue,
          targetKind:
            parsed.documentation.kind === "repository"
              ? "REPOSITORY"
              : "CONFLUENCE",
          documentation:
            parsed.documentation as Prisma.InputJsonValue,
          confidenceReasons:
            parsed.confidenceReasons as Prisma.InputJsonValue,
          createdAt: now,
        },
      });
      await transaction.auditEvent.create({
        data: {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          eventType: "drift_evidence_recorded",
          idempotencyKey: `drift-evidence:${digest}`,
          details: {
            evidenceClaimId: claim.id,
            digest,
            implementationSha: job.headSha,
          },
        },
      });
      return toEvidenceClaimRecord(claim);
    });
  }
}

function toEvidenceClaimRecord(claim: {
  id: string;
  reviewJobId: string;
  digest: string;
  claimText: string;
  implementationSha: string;
  implementationReferences: unknown;
  behaviorComparisons: unknown;
  documentation: unknown;
  confidenceReasons: unknown;
}): EvidenceClaimRecord {
  return evidenceClaimRecordSchema.parse({
    id: claim.id,
    reviewJobId: claim.reviewJobId,
    digest: claim.digest,
    claim: claim.claimText,
    implementationSha: claim.implementationSha,
    implementationReferences: claim.implementationReferences,
    behaviorComparisons: claim.behaviorComparisons,
    documentation: claim.documentation,
    confidenceReasons: claim.confidenceReasons,
  });
}
