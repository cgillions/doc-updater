import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";
import type {
  ChangeProposalInput,
  CompleteReviewJobInput,
  RecordDriftEvidenceInput,
} from "../../domain/reviews/review-records.ts";

/** Persistence contract for assigned evidence recording. */
export interface AssignedEvidenceRecorder<TResult> {
  record(
    reviewJobId: string,
    input: RecordDriftEvidenceInput,
  ): Promise<TResult>;
}

/** Persistence contract for assigned proposal creation. */
export interface AssignedProposalCreator<TResult> {
  create(
    reviewJobId: string,
    input: ChangeProposalInput,
  ): Promise<TResult>;
}

/** Persistence contract for assigned review completion. */
export interface AssignedReviewCompleter<TResult> {
  complete(
    reviewJobId: string,
    input: CompleteReviewJobInput,
  ): Promise<TResult>;
}

/**
 * Records evidence for the job selected by trusted session authentication.
 *
 * @returns The persistence result for the assigned job.
 */
export async function recordAssignedDriftEvidence<TResult>(
  auth: ReviewSessionAuth,
  input: RecordDriftEvidenceInput,
  recorder: AssignedEvidenceRecorder<TResult>,
): Promise<TResult> {
  return recorder.record(resolveAssignedReviewJobId(auth), input);
}

/**
 * Creates a proposal for the job selected by trusted session authentication.
 *
 * @returns The persistence result for the assigned job.
 */
export async function createAssignedChangeProposal<TResult>(
  auth: ReviewSessionAuth,
  input: ChangeProposalInput,
  creator: AssignedProposalCreator<TResult>,
): Promise<TResult> {
  return creator.create(resolveAssignedReviewJobId(auth), input);
}

/**
 * Completes the job selected by trusted session authentication.
 *
 * @returns The persisted terminal result for the assigned job.
 */
export async function completeAssignedReviewJob<TResult>(
  auth: ReviewSessionAuth,
  input: CompleteReviewJobInput,
  completer: AssignedReviewCompleter<TResult>,
): Promise<TResult> {
  return completer.complete(resolveAssignedReviewJobId(auth), input);
}
