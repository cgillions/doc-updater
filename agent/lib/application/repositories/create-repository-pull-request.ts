import { createHash } from "node:crypto";

import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";
import {
  createRepositoryPullRequestInputSchema,
  type CreateRepositoryPullRequestInput,
  type RepositoryPullRequestRecord,
} from "../../domain/reviews/review-records.ts";

/** Immutable repository proposal data loaded from trusted persistence. */
export interface RepositoryPullRequestProposal {
  id: string;
  reviewJobId: string;
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  digest: string;
  baseSha: string;
  path: string;
  content: string;
}

/** Stores trusted proposals and their completed pull-request artifacts. */
export interface RepositoryPullRequestArtifactStore {
  loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<RepositoryPullRequestProposal | null>;
  findCreated(
    idempotencyKey: string,
  ): Promise<RepositoryPullRequestRecord | null>;
  recordCreated(input: {
    proposal: RepositoryPullRequestProposal;
    idempotencyKey: string;
    branchName: string;
    commitSha: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }): Promise<RepositoryPullRequestRecord>;
}

/** Narrow write boundary for one already-validated repository proposal. */
export interface RepositoryPullRequestCreator {
  readDefaultBranchHead(input: {
    repositoryFullName: string;
    defaultBranch: string;
  }): Promise<string>;
  create(input: {
    repositoryFullName: string;
    defaultBranch: string;
    baseSha: string;
    branchName: string;
    path: string;
    content: string;
    commitMessage: string;
    title: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{
    commitSha: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
  }>;
}

/** Raised when the scheduled job does not own the requested stored proposal. */
export class RepositoryPullRequestUnavailableError extends Error {
  constructor(proposalDigest: string) {
    super(
      `Repository proposal ${JSON.stringify(proposalDigest)} is unavailable ` +
        "for the assigned review job.",
    );
    this.name = "RepositoryPullRequestUnavailableError";
  }
}

/** Raised when the default branch moved after the proposal's baseline. */
export class RepositoryPullRequestStaleBaseError extends Error {
  constructor(expectedBaseSha: string, actualBaseSha: string) {
    super(
      `Repository default branch moved from proposal base ${expectedBaseSha} ` +
        `to ${actualBaseSha}.`,
    );
    this.name = "RepositoryPullRequestStaleBaseError";
  }
}

/**
 * Creates one approval-gated pull request from an immutable stored proposal.
 *
 * Repository, branch, file, and content values are derived entirely from the
 * proposal loaded for the schedule-bound review job.
 */
export async function createAssignedRepositoryPullRequest(
  auth: ReviewSessionAuth,
  input: CreateRepositoryPullRequestInput,
  dependencies: {
    store: RepositoryPullRequestArtifactStore;
    github: RepositoryPullRequestCreator;
    audit?: {
      sessionId: string;
      toolCallId: string;
    };
  },
): Promise<RepositoryPullRequestRecord> {
  const parsed = createRepositoryPullRequestInputSchema.parse(input);
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
    throw new RepositoryPullRequestUnavailableError(parsed.proposalDigest);
  }

  const idempotencyKey = buildRepositoryPullRequestIdempotencyKey(proposal);
  const existing = await dependencies.store.findCreated(idempotencyKey);
  if (existing) {
    return existing;
  }

  const currentBaseSha = await dependencies.github.readDefaultBranchHead({
    repositoryFullName: proposal.repositoryFullName,
    defaultBranch: proposal.defaultBranch,
  });
  if (currentBaseSha !== proposal.baseSha) {
    throw new RepositoryPullRequestStaleBaseError(
      proposal.baseSha,
      currentBaseSha,
    );
  }

  const branchName = `docs/proposal-${idempotencyKey.slice(-12)}`;
  const result = await dependencies.github.create({
    repositoryFullName: proposal.repositoryFullName,
    defaultBranch: proposal.defaultBranch,
    baseSha: proposal.baseSha,
    branchName,
    path: proposal.path,
    content: proposal.content,
    commitMessage: `docs: update ${proposal.path}`,
    title: `docs: update ${proposal.path}`,
    body: `Applies documentation proposal ${proposal.digest}.`,
    idempotencyKey,
  });
  return dependencies.store.recordCreated({
    proposal,
    idempotencyKey,
    branchName,
    commitSha: result.commitSha,
    pullRequestNumber: result.pullRequestNumber,
    pullRequestUrl: result.pullRequestUrl,
    actorId: auth.current?.principalId,
    sessionId: dependencies.audit?.sessionId,
    toolCallId: dependencies.audit?.toolCallId,
  });
}

/** Builds a stable key across replays of the same repository change. */
export function buildRepositoryPullRequestIdempotencyKey(
  proposal: Pick<
    RepositoryPullRequestProposal,
    "repositoryId" | "baseSha" | "path" | "content"
  >,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "repository-pr-v1",
        proposal.repositoryId,
        proposal.baseSha,
        proposal.path,
        proposal.content,
      ]),
    )
    .digest("hex");
  return `repository-pull-request:repository-pr-v1:${digest}`;
}
