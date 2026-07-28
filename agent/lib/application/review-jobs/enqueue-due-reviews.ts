import type { EnqueueReviewJobInput } from "../../database/review-job-store.ts";
import type { ReviewJobMode } from "../../database/generated/enums.ts";

/** Immutable SHA range selected for one repository review. */
export interface DueReviewCandidate {
  repositoryId: string;
  baseSha: string | null;
  headSha: string;
  mode: ReviewJobMode;
}

/** Reads repositories whose persisted implementation baseline has changed. */
export interface DueReviewCandidateSource {
  listDueReviewCandidates(): Promise<DueReviewCandidate[]>;
}

/** Minimal durable queue boundary needed by the enqueuer. */
export interface DueReviewJobQueue {
  enqueue(input: EnqueueReviewJobInput): Promise<{ id: string }>;
}

/** Result of materializing one set of due repository reviews. */
export interface DueReviewEnqueueResult {
  candidateCount: number;
  jobIds: string[];
}

/**
 * Converts trusted registry candidates into idempotent review jobs.
 *
 * Candidate selection is deterministic application code; no repository list
 * is exposed to a model.
 */
export class DueReviewJobEnqueuer {
  private readonly candidates: DueReviewCandidateSource;
  private readonly queue: DueReviewJobQueue;

  constructor(
    candidates: DueReviewCandidateSource,
    queue: DueReviewJobQueue,
  ) {
    this.candidates = candidates;
    this.queue = queue;
  }

  /**
   * Enqueues every currently due candidate at the supplied availability time.
   *
   * @returns Candidate count and durable job IDs, including replayed jobs.
   */
  async enqueue(availableAt: Date = new Date()): Promise<DueReviewEnqueueResult> {
    const candidates = await this.candidates.listDueReviewCandidates();
    const jobIds: string[] = [];
    for (const candidate of candidates) {
      const job = await this.queue.enqueue({ ...candidate, availableAt });
      jobIds.push(job.id);
    }
    return { candidateCount: candidates.length, jobIds };
  }
}
