import { randomUUID } from "node:crypto";

import type {
  ClaimDueInput,
  CompleteReviewJobInput,
  FailReviewJobInput,
  RecoverExpiredLeasesInput,
} from "../../database/review-job-store.ts";
import {
  validateBatchSize,
  validateLeaseDuration,
} from "../../domain/review-jobs/review-job-policy.ts";
import type { DueReviewJobEnqueuer } from "./enqueue-due-reviews.ts";

/** Lease fields required to dispatch one review session. */
export interface DispatchableReviewJob {
  id: string;
  repositoryId: string;
  leaseToken: string;
}

/** Canonical Slack route bound to one claimed review job. */
export interface ReviewJobDispatchRoute {
  reviewJobId: string;
  slackChannelId: string;
}

/** Durable queue operations used during one dispatch invocation. */
export interface ReviewDispatchQueue {
  recoverExpiredLeases(
    input: RecoverExpiredLeasesInput,
  ): Promise<unknown[]>;
  claimDue(input: ClaimDueInput): Promise<DispatchableReviewJob[]>;
  complete(input: CompleteReviewJobInput): Promise<unknown>;
  fail(input: FailReviewJobInput): Promise<unknown>;
}

/** Loads trusted Slack routes for claimed jobs. */
export interface ReviewDispatchRouteSource {
  loadDispatchRoutes(
    reviewJobIds: readonly string[],
  ): Promise<ReviewJobDispatchRoute[]>;
}

/** Starts one isolated repository review session. */
export interface ReviewSessionReceiver {
  start(input: {
    reviewJobId: string;
    slackChannelId: string;
  }): Promise<{ sessionId: string }>;
}

/** Independent controls for queue claims and active sessions. */
export interface ReviewJobDispatcherConfig {
  claimLimit: number;
  concurrencyLimit: number;
  leaseForMs: number;
  claimAttempts: number;
  failureRetryMs: number;
}

/** Observable result of one deterministic dispatcher invocation. */
export interface ReviewJobDispatchResult {
  claimId: string;
  workerId: string;
  candidateCount: number;
  recoveredLeaseCount: number;
  claimedCount: number;
  completedCount: number;
  failedCount: number;
  sessionIds: string[];
}

/** Dependencies for `ReviewJobDispatcher`. */
export interface ReviewJobDispatcherOptions {
  enqueuer: Pick<DueReviewJobEnqueuer, "enqueue">;
  queue: ReviewDispatchQueue;
  routes: ReviewDispatchRouteSource;
  receiver: ReviewSessionReceiver;
  config: ReviewJobDispatcherConfig;
  createId?: () => string;
  clock?: () => Date;
}

/**
 * Claims jobs and starts one peer root session per repository.
 *
 * Queue selection, claim retries, routing, and concurrency remain outside the
 * model. Individual session failures are requeued without stopping peers.
 */
export class ReviewJobDispatcher {
  private readonly enqueuer: Pick<DueReviewJobEnqueuer, "enqueue">;
  private readonly queue: ReviewDispatchQueue;
  private readonly routes: ReviewDispatchRouteSource;
  private readonly receiver: ReviewSessionReceiver;
  private readonly config: ReviewJobDispatcherConfig;
  private readonly createId: () => string;
  private readonly clock: () => Date;

  constructor(options: ReviewJobDispatcherOptions) {
    this.enqueuer = options.enqueuer;
    this.queue = options.queue;
    this.routes = options.routes;
    this.receiver = options.receiver;
    this.config = validateReviewJobDispatcherConfig(options.config);
    this.createId = options.createId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Enqueues due work, recovers expired leases, and dispatches one batch.
   *
   * The claim and worker IDs are created once. Every retry of the database
   * claim reuses the exact same parameters.
   */
  async dispatch(): Promise<ReviewJobDispatchResult> {
    const claimId = this.createId();
    const workerId = this.createId();
    const invocationTime = this.clock();
    const enqueueResult = await this.enqueuer.enqueue(invocationTime);
    const recovered = await this.queue.recoverExpiredLeases({
      limit: this.config.claimLimit,
      now: invocationTime,
    });
    const jobs = await this.claimWithRetry({
      claimId,
      workerId,
      limit: this.config.claimLimit,
      leaseForMs: this.config.leaseForMs,
      now: invocationTime,
    });
    const routes = new Map(
      (
        await this.routes.loadDispatchRoutes(jobs.map(({ id }) => id))
      ).map((route) => [route.reviewJobId, route.slackChannelId]),
    );

    const outcomes = await mapWithConcurrency(
      jobs,
      this.config.concurrencyLimit,
      (job) => this.dispatchJob(job, routes.get(job.id)),
    );
    return {
      claimId,
      workerId,
      candidateCount: enqueueResult.candidateCount,
      recoveredLeaseCount: recovered.length,
      claimedCount: jobs.length,
      completedCount: outcomes.filter(({ completed }) => completed).length,
      failedCount: outcomes.filter(({ completed }) => !completed).length,
      sessionIds: outcomes.flatMap(({ sessionId }) =>
        sessionId ? [sessionId] : [],
      ),
    };
  }

  private async claimWithRetry(
    input: ClaimDueInput,
  ): Promise<DispatchableReviewJob[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.claimAttempts; attempt += 1) {
      try {
        return await this.queue.claimDue(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async dispatchJob(
    job: DispatchableReviewJob,
    slackChannelId: string | undefined,
  ): Promise<{ completed: boolean; sessionId?: string }> {
    if (!slackChannelId) {
      await this.failJob(
        job,
        "SLACK_ROUTE_UNAVAILABLE",
        "The claimed repository no longer has a trusted Slack route.",
      );
      return { completed: false };
    }

    try {
      const session = await this.receiver.start({
        reviewJobId: job.id,
        slackChannelId,
      });
      await this.queue.complete({
        jobId: job.id,
        leaseToken: job.leaseToken,
        completedAt: this.clock(),
      });
      return { completed: true, sessionId: session.sessionId };
    } catch (error) {
      await this.failJob(
        job,
        "REVIEW_SESSION_FAILED",
        errorMessage(error),
      );
      return { completed: false };
    }
  }

  private async failJob(
    job: DispatchableReviewJob,
    code: string,
    message: string,
  ): Promise<void> {
    const failedAt = this.clock();
    try {
      await this.queue.fail({
        jobId: job.id,
        leaseToken: job.leaseToken,
        code,
        message,
        failedAt,
        retryAt: new Date(
          failedAt.getTime() + this.config.failureRetryMs,
        ),
      });
    } catch {
      // Lease expiry provides a second recovery path if failure persistence
      // itself is unavailable. This job must not block unrelated sessions.
    }
  }
}

/** Validates operational claim, lease, retry, and concurrency limits. */
export function validateReviewJobDispatcherConfig(
  config: ReviewJobDispatcherConfig,
): ReviewJobDispatcherConfig {
  validateBatchSize(config.claimLimit);
  validateLeaseDuration(config.leaseForMs);
  validateLeaseDuration(config.failureRetryMs);
  if (
    !Number.isInteger(config.concurrencyLimit) ||
    config.concurrencyLimit < 1 ||
    config.concurrencyLimit > config.claimLimit
  ) {
    throw new RangeError(
      "Review session concurrency must be between 1 and the claim limit.",
    );
  }
  if (
    !Number.isInteger(config.claimAttempts) ||
    config.claimAttempts < 1 ||
    config.claimAttempts > 5
  ) {
    throw new RangeError("Review job claim attempts must be between 1 and 5.");
  }
  return config;
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown review session failure.";
  return message.slice(0, 1_000);
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      results[currentIndex] = await mapper(values[currentIndex]!);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}
