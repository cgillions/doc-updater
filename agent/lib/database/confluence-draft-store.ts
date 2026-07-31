import type { Prisma, PrismaClient } from "./generated/client.ts";

import {
  buildChangeProposalDigest,
  changeProposalInputSchema,
  confluenceDraftBlockedRecordSchema,
  confluenceDraftRecordSchema,
  type ConfluenceDraftBlockedRecord,
  type ConfluenceDraftRecord,
} from "../domain/reviews/review-records.ts";
import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import {
  loadReviewRecordJob,
  type ReviewRecordJob,
} from "./review-record-helpers.ts";

/** Immutable Confluence proposal data loaded from trusted persistence. */
export interface ConfluenceDraftProposal {
  id: string;
  repositoryId: string;
  reviewJobId: string;
  digest: string;
  implementationSha: string;
  pageTitle?: string;
  pageUrl?: string;
  target: {
    siteId: string;
    pageId: string;
    version: number;
    bodyHash: string;
  };
  patch: {
    baselineStorageValue: string;
    baselineFragmentHash: string;
    replacementStorageValue: string;
  };
}

/** Coordinates an approved draft creation through trusted persistence. */
export interface ConfluenceDraftArtifactStore {
  loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<ConfluenceDraftProposal | null>;
  withPageLock<TResult>(
    target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ): Promise<TResult>;
  recordCreated(input: {
    proposal: ConfluenceDraftProposal;
    draftPageId: string;
    draftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftRecord>;
  recordBlockedByExistingDraft(input: {
    proposal: ConfluenceDraftProposal;
    existingDraftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftBlockedRecord>;
}

/**
 * Loads trusted exact-page proposals and records immutable historical artifacts.
 */
export class ConfluenceDraftStore implements ConfluenceDraftArtifactStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  async loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<ConfluenceDraftProposal | null> {
    return this.database.$transaction(async (transaction) => {
      const job = await loadReviewRecordJob(transaction, reviewJobId);
      if (!job.repositoryIsEligible || !job.roadieScopeIsResolved) {
        return null;
      }
      const proposal = await transaction.changeProposal.findFirst({
        where: {
          reviewJobId: job.id,
          digest: proposalDigest,
          targetKind: "CONFLUENCE",
        },
      });
      if (!proposal) {
        return null;
      }

      const proposalEvidenceClaimIds = await evidenceClaimIds(
        transaction,
        proposal.id,
      );
      const parsed = changeProposalInputSchema.parse({
        target: proposal.target,
        patch: proposal.patch,
        evidenceClaimIds: proposalEvidenceClaimIds,
      });
      if (
        parsed.target.kind !== "confluence" ||
        parsed.patch.kind !== "confluence-storage-fragment-replacement" ||
        proposal.repositoryBaselineSha !== null ||
        proposal.digest !==
          buildChangeProposalDigest(job.id, job.headSha, {
            ...parsed,
            evidenceClaimIds: proposalEvidenceClaimIds,
          }) ||
        !isConfluenceTarget(job.documentationScope, parsed.target.siteId, parsed.target.pageId)
      ) {
        throw new ReviewRecordConflictError(
          "Confluence draft proposal digest, scope, or baseline is invalid.",
        );
      }
      if (
        !isExactConfluenceTarget(
          job.documentationScope,
          parsed.target.siteId,
          parsed.target.pageId,
        )
      ) {
        return null;
      }

      const provenance = exactConfluenceProvenance(
        job.documentationScope,
        parsed.target.siteId,
        parsed.target.pageId,
      );
      return {
        id: proposal.id,
        repositoryId: job.repositoryId,
        reviewJobId: job.id,
        digest: proposal.digest,
        implementationSha: job.headSha,
        pageTitle: provenance?.title,
        pageUrl: provenance?.url,
        target: {
          siteId: parsed.target.siteId,
          pageId: parsed.target.pageId,
          version: parsed.target.version,
          bodyHash: parsed.target.bodyHash,
        },
        patch: {
          baselineStorageValue: parsed.patch.baselineStorageValue,
          baselineFragmentHash: parsed.patch.baselineFragmentHash,
          replacementStorageValue: parsed.patch.replacementStorageValue,
        },
      };
    });
  }

  /** Serializes draft creation per canonical Confluence page across workers. */
  async withPageLock<TResult>(
    target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    const lockKey = JSON.stringify([target.siteId, target.pageId]);
    return this.database.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))
        `;
        return action();
      },
      { maxWait: 5_000, timeout: 60_000 },
    );
  }

  async recordCreated(input: {
    proposal: ConfluenceDraftProposal;
    draftPageId: string;
    draftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftRecord> {
    const record = confluenceDraftRecordSchema.parse({
      proposalDigest: input.proposal.digest,
      pageId: input.proposal.target.pageId,
      draftPageId: input.draftPageId,
      draftVersion: input.draftVersion,
      status: "draft",
    });
    return this.database.$transaction(async (transaction) => {
      const artifact = await transaction.confluenceDraftArtifact.create({
        data: {
          repositoryId: input.proposal.repositoryId,
          reviewJobId: input.proposal.reviewJobId,
          changeProposalId: input.proposal.id,
          proposalDigest: input.proposal.digest,
          siteId: input.proposal.target.siteId,
          pageId: input.proposal.target.pageId,
          baselineVersion: input.proposal.target.version,
          baselineBodyHash: input.proposal.target.bodyHash,
          draftPageId: record.draftPageId,
          draftVersion: record.draftVersion,
        },
      });
      await transaction.auditEvent.create({
        data: {
          repositoryId: input.proposal.repositoryId,
          reviewJobId: input.proposal.reviewJobId,
          eventType: "confluence_draft_created",
          idempotencyKey: confluenceDraftIdempotencyKey(artifact.id),
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
    });
  }

  /** Records a replayable non-write outcome reported by Confluence. */
  async recordBlockedByExistingDraft(input: {
    proposal: ConfluenceDraftProposal;
    existingDraftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftBlockedRecord> {
    const record = confluenceDraftBlockedRecordSchema.parse({
      proposalDigest: input.proposal.digest,
      pageId: input.proposal.target.pageId,
      status: "blocked-existing-draft",
    });
    if (!Number.isSafeInteger(input.existingDraftVersion) || input.existingDraftVersion < 1) {
      throw new ReviewRecordConflictError(
        "Confluence reported an invalid existing draft version.",
      );
    }

    const audit = await this.database.auditEvent.upsert({
      where: {
        idempotencyKey: confluenceDraftBlockedIdempotencyKey(
          input.proposal.digest,
          input.existingDraftVersion,
        ),
      },
      create: {
        repositoryId: input.proposal.repositoryId,
        reviewJobId: input.proposal.reviewJobId,
        eventType: "confluence_draft_blocked_existing_draft",
        idempotencyKey: confluenceDraftBlockedIdempotencyKey(
          input.proposal.digest,
          input.existingDraftVersion,
        ),
        actorId: input.actorId,
        details: {
          proposalId: input.proposal.id,
          observedDraftVersion: input.existingDraftVersion,
          actorId: input.actorId ?? null,
          sessionId: input.sessionId ?? null,
          toolCallId: input.toolCallId ?? null,
          ...record,
        } as Prisma.InputJsonValue,
      },
      update: {},
    });
    return requireMatchingBlockedRecord(audit.details, record);
  }
}

function exactConfluenceProvenance(
  scope: ReviewRecordJob["documentationScope"],
  siteId: string,
  pageId: string,
): { title?: string; url: string } | undefined {
  const target = scope.find(
    (candidate) => candidate.siteId === siteId && candidate.pageId === pageId,
  );
  return target?.declarations.find(({ kind }) => kind === "exact")?.provenance;
}

function isExactConfluenceTarget(
  scope: ReadonlyArray<{
    siteId: string;
    pageId: string;
    declarations: ReadonlyArray<{ kind: "exact" | "root" }>;
  }>,
  siteId: string,
  pageId: string,
): boolean {
  return scope.some(
    (target) =>
      target.siteId === siteId &&
      target.pageId === pageId &&
      target.declarations.some(({ kind }) => kind === "exact"),
  );
}

function isConfluenceTarget(
  scope: ReadonlyArray<{
    siteId: string;
    pageId: string;
  }>,
  siteId: string,
  pageId: string,
): boolean {
  return scope.some(
    (target) => target.siteId === siteId && target.pageId === pageId,
  );
}

async function evidenceClaimIds(
  transaction: Prisma.TransactionClient,
  proposalId: string,
): Promise<string[]> {
  const links = await transaction.changeProposalEvidence.findMany({
    where: { changeProposalId: proposalId },
    select: { evidenceClaimId: true },
  });
  return links.map(({ evidenceClaimId }) => evidenceClaimId).sort();
}

function requireMatchingBlockedRecord(
  persisted: unknown,
  expected: ConfluenceDraftBlockedRecord,
): ConfluenceDraftBlockedRecord {
  const record = confluenceDraftBlockedRecordSchema.parse(persisted);
  if (
    record.proposalDigest !== expected.proposalDigest ||
    record.pageId !== expected.pageId ||
    record.status !== expected.status
  ) {
    throw new ReviewRecordConflictError(
      "Confluence draft conflict idempotency key was replayed with a different record.",
    );
  }
  return record;
}

function confluenceDraftIdempotencyKey(artifactId: string): string {
  return `confluence-draft:confluence-draft-v1:${artifactId}`;
}

function confluenceDraftBlockedIdempotencyKey(
  proposalDigest: string,
  existingDraftVersion: number,
): string {
  return `confluence-draft-blocked:confluence-draft-v1:${proposalDigest}:${existingDraftVersion}`;
}
