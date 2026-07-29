import {
  hashConfluenceBody,
  type ConfluencePage,
} from "../../domain/documentation/confluence-page.ts";
import {
  createConfluenceDraftInputSchema,
  type ConfluenceDraftCreationResult,
  type CreateConfluenceDraftInput,
} from "../../domain/reviews/review-records.ts";
import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import type {
  ConfluenceDraftArtifactStore,
  ConfluenceDraftProposal,
} from "../../database/confluence-draft-store.ts";
import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";

/** Reads trusted current content and Confluence draft state for one page. */
export interface ConfluencePageReader {
  getPage(target: { siteId: string; pageId: string }): Promise<ConfluencePage>;
  getDraftState(target: { siteId: string; pageId: string }): Promise<{
    pageId: string;
    version: number;
  } | null>;
}

/** Narrow write boundary that can only update one existing page as a draft. */
export interface ConfluenceDraftCreator {
  createDraft(input: {
    page: ConfluencePage;
    bodyStorageValue: string;
    auditMessage: string;
  }): Promise<{
    draftPageId: string;
    draftVersion: number;
    status: "draft";
  }>;
}

/** Raised when no trusted proposal belongs to the assigned review job. */
export class ConfluenceDraftUnavailableError extends Error {
  constructor(proposalDigest: string) {
    super(
      `Confluence proposal ${JSON.stringify(proposalDigest)} is unavailable ` +
        "for the assigned review job.",
    );
    this.name = "ConfluenceDraftUnavailableError";
  }
}

/** Raised when the current page no longer matches the proposal baseline. */
export class ConfluenceDraftStalePageError extends Error {
  constructor(proposal: ConfluenceDraftProposal, current: ConfluencePage) {
    super(
      `Confluence page ${proposal.target.siteId}/${proposal.target.pageId} ` +
        `changed from version ${proposal.target.version} to ${current.version}.`,
    );
    this.name = "ConfluenceDraftStalePageError";
  }
}

/**
 * Creates one approved, unpublished draft from a trusted exact-page proposal.
 *
 * The writer receives only persisted coordinates and a reconstructed native
 * page body; it never accepts model-authored page or publication inputs.
 */
export async function createAssignedConfluenceDraft(
  auth: ReviewSessionAuth,
  input: CreateConfluenceDraftInput,
  dependencies: {
    store: ConfluenceDraftArtifactStore;
    pages: ConfluencePageReader;
    drafts: ConfluenceDraftCreator;
    audit?: {
      sessionId: string;
      toolCallId: string;
    };
  },
): Promise<ConfluenceDraftCreationResult> {
  const parsed = createConfluenceDraftInputSchema.parse(input);
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
    throw new ConfluenceDraftUnavailableError(parsed.proposalDigest);
  }

  return dependencies.store.withPageLock(proposal.target, async () => {
    // Confluence has no atomic "create only when no draft exists" operation.
    // Source: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/
    const existingPageDraft = await dependencies.pages.getDraftState(
      proposal.target,
    );
    if (existingPageDraft) {
      return dependencies.store.recordBlockedByExistingDraft({
        proposal,
        existingDraftVersion: existingPageDraft.version,
        actorId: auth.current?.principalId,
        sessionId: dependencies.audit?.sessionId,
        toolCallId: dependencies.audit?.toolCallId,
      });
    }

    const current = await dependencies.pages.getPage(proposal.target);
    if (!matchesBaseline(proposal, current)) {
      throw new ConfluenceDraftStalePageError(proposal, current);
    }
    const bodyStorageValue = replaceExactFragment(proposal, current);
    const draft = await dependencies.drafts.createDraft({
      page: current,
      bodyStorageValue,
      auditMessage: buildAuditMessage(proposal),
    });
    if (draft.status !== "draft" || draft.draftPageId !== current.pageId) {
      throw new ReviewRecordConflictError(
        "Confluence did not return an unpublished draft for the expected page.",
      );
    }
    return dependencies.store.recordCreated({
      proposal,
      draftPageId: draft.draftPageId,
      draftVersion: draft.draftVersion,
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
  const secondMatch = page.bodyStorageValue.indexOf(
    baseline,
    firstMatch + 1,
  );
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
  return (
    `Documentation proposal ${proposal.digest} for review ${proposal.reviewJobId} ` +
    `at source ${proposal.implementationSha}.`
  );
}
