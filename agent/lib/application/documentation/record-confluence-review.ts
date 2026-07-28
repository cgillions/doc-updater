import { hashConfluenceBody } from "../../domain/documentation/confluence-page.ts";
import type {
  CreateConfluenceProposalInput,
  RecordConfluenceEvidenceInput,
} from "../../domain/documentation/confluence-page.ts";
import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import type {
  ChangeProposalInput,
  RecordDriftEvidenceInput,
} from "../../domain/reviews/review-records.ts";
import type { ConfluencePageStore } from "../../database/confluence-page-store.ts";
import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";

export interface ConfluenceEvidenceRecorder<TResult> {
  record(
    reviewJobId: string,
    input: RecordDriftEvidenceInput,
  ): Promise<TResult>;
}

export interface ConfluenceProposalCreator<TResult> {
  create(
    reviewJobId: string,
    input: ChangeProposalInput,
  ): Promise<TResult>;
}

export interface ConfluenceSnapshotSource {
  loadCandidate(
    reviewJobId: string,
    candidateId: string,
  ): ReturnType<ConfluencePageStore["loadCandidate"]>;
}

export class AssignedConfluenceReviewRecorder {
  private readonly pages: ConfluenceSnapshotSource;

  constructor(pages: ConfluenceSnapshotSource) {
    this.pages = pages;
  }

  async recordEvidence<TResult>(
    auth: ReviewSessionAuth,
    input: RecordConfluenceEvidenceInput,
    recorder: ConfluenceEvidenceRecorder<TResult>,
  ): Promise<TResult> {
    const reviewJobId = resolveAssignedReviewJobId(auth);
    const candidate = await this.requireSnapshot(
      reviewJobId,
      input.candidateId,
    );
    return recorder.record(reviewJobId, {
      claim: input.claim,
      implementationReferences: input.implementationReferences,
      confidenceReasons: input.confidenceReasons,
      documentation: {
        kind: "confluence",
        siteId: candidate.siteId,
        pageId: candidate.pageId,
        version: candidate.snapshot.version,
        bodyHash: candidate.snapshot.bodyHash,
      },
    });
  }

  async createProposal<TResult>(
    auth: ReviewSessionAuth,
    input: CreateConfluenceProposalInput,
    creator: ConfluenceProposalCreator<TResult>,
  ): Promise<TResult> {
    const reviewJobId = resolveAssignedReviewJobId(auth);
    const candidate = await this.requireSnapshot(
      reviewJobId,
      input.candidateId,
    );
    const pageStorageValue = candidate.snapshot.bodyStorageValue;
    const fragmentStart = pageStorageValue.indexOf(input.baselineStorageValue);
    const repeatedFragmentStart = pageStorageValue.indexOf(
      input.baselineStorageValue,
      fragmentStart + 1,
    );
    if (fragmentStart < 0 || repeatedFragmentStart >= 0) {
      throw new ReviewRecordConflictError(
        "Confluence proposal baseline fragment must occur exactly once in the fetched page.",
      );
    }
    return creator.create(reviewJobId, {
      target: {
        kind: "confluence",
        siteId: candidate.siteId,
        pageId: candidate.pageId,
        version: candidate.snapshot.version,
        bodyHash: candidate.snapshot.bodyHash,
      },
      patch: {
        kind: "confluence-storage-fragment-replacement",
        baselineStorageValue: input.baselineStorageValue,
        baselineFragmentHash: hashConfluenceBody(
          input.baselineStorageValue,
        ),
        replacementStorageValue: input.replacementStorageValue,
      },
      evidenceClaimIds: input.evidenceClaimIds,
    });
  }

  private async requireSnapshot(
    reviewJobId: string,
    candidateId: string,
  ) {
    const candidate = await this.pages.loadCandidate(
      reviewJobId,
      candidateId,
    );
    if (!candidate?.snapshot) {
      throw new ReviewRecordConflictError(
        "Confluence candidate has not been fetched for this review job.",
      );
    }
    return {
      ...candidate,
      snapshot: candidate.snapshot,
    };
  }
}
