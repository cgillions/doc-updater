import type { Prisma, PrismaClient } from "./generated/client.ts";

import {
  confluenceDraftBlockedRecordSchema,
  confluencePageUpdateRecordSchema,
  type ConfluenceDraftBlockedRecord,
  type ConfluencePageUpdateRecord,
} from "../domain/reviews/review-records.ts";
import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import {
  ConfluenceDraftStore,
  type ConfluenceDraftProposal,
} from "./confluence-draft-store.ts";

export interface ConfluencePageUpdateArtifactStore {
  loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<ConfluenceDraftProposal | null>;
  withPageLock<TResult>(
    target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ): Promise<TResult>;
  recordPublished(input: {
    proposal: ConfluenceDraftProposal;
    pageId: string;
    publishedVersion: number;
    pageUrl: string;
    historyUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluencePageUpdateRecord>;
  recordBlockedByExistingDraft(input: {
    proposal: ConfluenceDraftProposal;
    existingDraftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftBlockedRecord>;
}

/** Persists published Confluence versions while retaining historical draft data. */
export class ConfluencePageUpdateStore
  implements ConfluencePageUpdateArtifactStore
{
  private readonly database: PrismaClient;
  private readonly proposals: ConfluenceDraftStore;

  constructor(database: PrismaClient) {
    this.database = database;
    this.proposals = new ConfluenceDraftStore(database);
  }

  loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<ConfluenceDraftProposal | null> {
    return this.proposals.loadProposal(reviewJobId, proposalDigest);
  }

  withPageLock<TResult>(
    target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    return this.proposals.withPageLock(target, action);
  }

  async recordPublished(input: {
    proposal: ConfluenceDraftProposal;
    pageId: string;
    publishedVersion: number;
    pageUrl: string;
    historyUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluencePageUpdateRecord> {
    const record = confluencePageUpdateRecordSchema.parse({
      proposalDigest: input.proposal.digest,
      pageId: input.pageId,
      publishedVersion: input.publishedVersion,
      pageUrl: input.pageUrl,
      historyUrl: input.historyUrl,
      status: "published",
    });
    return this.database.$transaction(async (transaction) => {
      const artifact = await transaction.confluencePageUpdateArtifact.create({
        data: {
          repositoryId: input.proposal.repositoryId,
          reviewJobId: input.proposal.reviewJobId,
          changeProposalId: input.proposal.id,
          proposalDigest: input.proposal.digest,
          siteId: input.proposal.target.siteId,
          pageId: record.pageId,
          baselineVersion: input.proposal.target.version,
          baselineBodyHash: input.proposal.target.bodyHash,
          publishedVersion: record.publishedVersion,
          pageUrl: record.pageUrl,
          historyUrl: record.historyUrl,
        },
      });
      await transaction.auditEvent.create({
        data: {
          repositoryId: input.proposal.repositoryId,
          reviewJobId: input.proposal.reviewJobId,
          eventType: "confluence_page_update_published",
          idempotencyKey: `confluence-page-update:v1:${artifact.id}`,
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

  async recordBlockedByExistingDraft(input: {
    proposal: ConfluenceDraftProposal;
    existingDraftVersion: number;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<ConfluenceDraftBlockedRecord> {
    if (
      !Number.isSafeInteger(input.existingDraftVersion) ||
      input.existingDraftVersion < 1
    ) {
      throw new ReviewRecordConflictError(
        "Confluence reported an invalid existing draft version.",
      );
    }
    const record = confluenceDraftBlockedRecordSchema.parse({
      proposalDigest: input.proposal.digest,
      pageId: input.proposal.target.pageId,
      status: "blocked-existing-draft",
    });
    const idempotencyKey =
      `confluence-page-update-blocked:v1:${input.proposal.digest}:` +
      input.existingDraftVersion;
    const audit = await this.database.auditEvent.upsert({
      where: { idempotencyKey },
      create: {
        repositoryId: input.proposal.repositoryId,
        reviewJobId: input.proposal.reviewJobId,
        eventType: "confluence_page_update_blocked_existing_draft",
        idempotencyKey,
        actorId: input.actorId,
        details: {
          proposalId: input.proposal.id,
          observedDraftVersion: input.existingDraftVersion,
          sessionId: input.sessionId ?? null,
          toolCallId: input.toolCallId ?? null,
          ...record,
        } as Prisma.InputJsonValue,
      },
      update: {},
    });
    return confluenceDraftBlockedRecordSchema.parse(audit.details);
  }
}
