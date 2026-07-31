import type { ConfluencePageUpdateArtifactStore } from "../../database/confluence-page-update-store.ts";
import type { ConfluenceDraftProposal } from "../../database/confluence-draft-store.ts";
import {
  hashConfluenceBody,
  type ConfluencePage,
} from "../../domain/documentation/confluence-page.ts";
import {
  publishConfluencePageUpdateInputSchema,
  type ConfluencePageUpdateResult,
  type PublishConfluencePageUpdateInput,
} from "../../domain/reviews/review-records.ts";
import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";

export interface ConfluencePageReader {
  getPage(target: { siteId: string; pageId: string }): Promise<ConfluencePage>;
  getDraftState(target: { siteId: string; pageId: string }): Promise<{
    pageId: string;
    version: number;
  } | null>;
}

export interface ConfluencePageUpdater {
  updatePage(input: {
    page: ConfluencePage;
    bodyStorageValue: string;
    auditMessage: string;
  }): Promise<{
    pageId: string;
    publishedVersion: number;
    pageUrl: string;
    historyUrl: string;
    status: "published";
  }>;
}

export class ConfluencePageUpdateUnavailableError extends Error {
  constructor(proposalDigest: string) {
    super(
      `Confluence proposal ${JSON.stringify(proposalDigest)} is unavailable ` +
        "for the assigned review job.",
    );
    this.name = "ConfluencePageUpdateUnavailableError";
  }
}

export class ConfluencePageUpdateStalePageError extends Error {
  constructor(proposal: ConfluenceDraftProposal, current: ConfluencePage) {
    super(
      `Confluence page ${proposal.target.siteId}/${proposal.target.pageId} ` +
        `changed from version ${proposal.target.version} to ${current.version}.`,
    );
    this.name = "ConfluencePageUpdateStalePageError";
  }
}

/** Publishes the exact persisted proposal after Eve's approval gate succeeds. */
export async function publishAssignedConfluencePageUpdate(
  auth: ReviewSessionAuth,
  input: PublishConfluencePageUpdateInput,
  dependencies: {
    store: ConfluencePageUpdateArtifactStore;
    pages: ConfluencePageReader;
    updater: ConfluencePageUpdater;
    audit?: { sessionId: string; toolCallId: string };
  },
): Promise<ConfluencePageUpdateResult> {
  const parsed = publishConfluencePageUpdateInputSchema.parse(input);
  const reviewJobId = resolveAssignedReviewJobId(auth);
  const proposal = await dependencies.store.loadProposal(
    reviewJobId,
    parsed.proposalDigest,
  );
  if (
    !proposal ||
    proposal.reviewJobId !== reviewJobId ||
    proposal.digest !== parsed.proposalDigest
  ) {
    throw new ConfluencePageUpdateUnavailableError(parsed.proposalDigest);
  }

  return dependencies.store.withPageLock(proposal.target, async () => {
    const existingDraft = await dependencies.pages.getDraftState(proposal.target);
    if (existingDraft) {
      return dependencies.store.recordBlockedByExistingDraft({
        proposal,
        existingDraftVersion: existingDraft.version,
        actorId: auth.current?.principalId,
        sessionId: dependencies.audit?.sessionId,
        toolCallId: dependencies.audit?.toolCallId,
      });
    }

    const current = await dependencies.pages.getPage(proposal.target);
    if (!matchesBaseline(proposal, current)) {
      throw new ConfluencePageUpdateStalePageError(proposal, current);
    }
    const published = await dependencies.updater.updatePage({
      page: current,
      bodyStorageValue: replaceExactFragment(proposal, current),
      auditMessage: buildAuditMessage(proposal),
    });
    if (
      published.status !== "published" ||
      published.pageId !== current.pageId ||
      published.publishedVersion !== current.version + 1
    ) {
      throw new ReviewRecordConflictError(
        "Confluence did not publish the expected page version.",
      );
    }
    return dependencies.store.recordPublished({
      proposal,
      ...published,
      actorId: auth.current?.principalId,
      sessionId: dependencies.audit?.sessionId,
      toolCallId: dependencies.audit?.toolCallId,
    });
  });
}

function matchesBaseline(
  proposal: ConfluenceDraftProposal,
  current: ConfluencePage,
): boolean {
  return (
    current.siteId === proposal.target.siteId &&
    current.pageId === proposal.target.pageId &&
    current.status === "current" &&
    current.version === proposal.target.version &&
    current.bodyHash === proposal.target.bodyHash
  );
}

function replaceExactFragment(
  proposal: ConfluenceDraftProposal,
  page: ConfluencePage,
): string {
  const baseline = proposal.patch.baselineStorageValue;
  if (hashConfluenceBody(baseline) !== proposal.patch.baselineFragmentHash) {
    throw new ReviewRecordConflictError(
      "Confluence proposal baseline fragment hash is invalid.",
    );
  }
  const firstMatch = page.bodyStorageValue.indexOf(baseline);
  const secondMatch = page.bodyStorageValue.indexOf(baseline, firstMatch + 1);
  if (firstMatch < 0 || secondMatch >= 0) {
    throw new ReviewRecordConflictError(
      "Confluence proposal baseline fragment is no longer uniquely present.",
    );
  }
  return (
    page.bodyStorageValue.slice(0, firstMatch) +
    proposal.patch.replacementStorageValue +
    page.bodyStorageValue.slice(firstMatch + baseline.length)
  );
}

function buildAuditMessage(proposal: ConfluenceDraftProposal): string {
  return `Approved documentation proposal ${proposal.digest}.`;
}
