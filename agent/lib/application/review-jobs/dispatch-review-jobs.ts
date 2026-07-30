import { randomUUID } from "node:crypto";

import type {
  ClaimDueInput,
  FailReviewJobInput,
  RecoverExpiredLeasesInput,
} from "../../database/review-job-store.ts";
import {
  validateBatchSize,
  validateLeaseDuration,
} from "../../domain/review-jobs/review-job-policy.ts";
import {
  createLogger,
  durationMs,
  type Logger,
} from "../../observability/logger.ts";
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
  hasRecordedOutcome(jobId: string, leaseToken: string): Promise<boolean>;
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
  logger?: Logger;
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
  private readonly logger: Logger;

  constructor(options: ReviewJobDispatcherOptions) {
    this.enqueuer = options.enqueuer;
    this.queue = options.queue;
    this.routes = options.routes;
    this.receiver = options.receiver;
    this.config = validateReviewJobDispatcherConfig(options.config);
    this.createId = options.createId ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? createLogger("review-dispatcher");
  }

  /**
   * Enqueues due work, recovers expired leases, and dispatches one batch.
   *
   * The claim and worker IDs are created once. Every retry of the database
   * claim reuses the exact same parameters.
   */
  async dispatch(): Promise<ReviewJobDispatchResult> {
    const startedAt = process.hrtime.bigint();
    const claimId = this.createId();
    const workerId = this.createId();
    const invocationTime = this.clock();
    this.logger.info("review dispatch started", {
      claimId,
      workerId,
      claimLimit: this.config.claimLimit,
      claimAttempts: this.config.claimAttempts,
      concurrencyLimit: this.config.concurrencyLimit,
      leaseForMs: this.config.leaseForMs,
    });
    const enqueueResult = await this.enqueuer.enqueue(invocationTime);
    this.logger.info("due review jobs enqueued", {
      claimId,
      workerId,
      candidateCount: enqueueResult.candidateCount,
      jobCount: enqueueResult.jobIds.length,
    });
    const recovered = await this.queue.recoverExpiredLeases({
      limit: this.config.claimLimit,
      now: invocationTime,
    });
    this.logger.info("expired review leases recovered", {
      claimId,
      workerId,
      recoveredLeaseCount: recovered.length,
    });
    const jobs = await this.claimWithRetry({
      claimId,
      workerId,
      limit: this.config.claimLimit,
      leaseForMs: this.config.leaseForMs,
      now: invocationTime,
    });
    this.logger.info("review jobs claimed", {
      claimId,
      workerId,
      claimedCount: jobs.length,
      repositoryIds: jobs.map(({ repositoryId }) => repositoryId),
    });
    const routes = new Map(
      (
        await this.routes.loadDispatchRoutes(jobs.map(({ id }) => id))
      ).map((route) => [route.reviewJobId, route.slackChannelId]),
    );
    this.logger.info("review dispatch routes loaded", {
      claimId,
      workerId,
      routeCount: routes.size,
      missingRouteJobIds: jobs
        .filter((job) => !routes.has(job.id))
        .map((job) => job.id),
    });

    const outcomes = await mapWithConcurrency(
      jobs,
      this.config.concurrencyLimit,
      (job) => this.dispatchJob(job, routes.get(job.id)),
    );
    const result = {
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
    this.logger.info("review dispatch completed", {
      ...result,
      durationMs: durationMs(startedAt),
    });
    return result;
  }

  private async claimWithRetry(
    input: ClaimDueInput,
  ): Promise<DispatchableReviewJob[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.claimAttempts; attempt += 1) {
      try {
        const jobs = await this.queue.claimDue(input);
        this.logger.info("review job claim attempt completed", {
          attempt,
          claimId: input.claimId,
          claimedCount: jobs.length,
          workerId: input.workerId,
        });
        return jobs;
      } catch (error) {
        lastError = error;
        this.logger.warn("review job claim attempt failed", {
          attempt,
          claimId: input.claimId,
          errorMessage: errorMessage(error),
          remainingAttempts: this.config.claimAttempts - attempt,
          workerId: input.workerId,
        });
      }
    }
    throw lastError;
  }

  private async dispatchJob(
    job: DispatchableReviewJob,
    slackChannelId: string | undefined,
  ): Promise<{ completed: boolean; sessionId?: string }> {
    if (!slackChannelId) {
      this.logger.warn("review job has no Slack route", {
        jobId: job.id,
        repositoryId: job.repositoryId,
      });
      await this.failJob(
        job,
        "SLACK_ROUTE_UNAVAILABLE",
        "The claimed repository no longer has a trusted Slack route.",
      );
      return { completed: false };
    }

    try {
      this.logger.info("review session starting", {
        jobId: job.id,
        repositoryId: job.repositoryId,
        slackChannelId,
      });
      const session = await this.receiver.start({
        reviewJobId: job.id,
        slackChannelId,
      });
      if (!(await this.queue.hasRecordedOutcome(job.id, job.leaseToken))) {
        throw new Error(
          "The review session settled without recording a terminal outcome.",
        );
      }
      this.logger.info("review session completed", {
        jobId: job.id,
        repositoryId: job.repositoryId,
        sessionId: session.sessionId,
      });
      return { completed: true, sessionId: session.sessionId };
    } catch (error) {
      this.logger.warn("review session failed", {
        jobId: job.id,
        repositoryId: job.repositoryId,
        errorMessage: errorMessage(error),
      });
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
      this.logger.info("review job failure persisted", {
        code,
        jobId: job.id,
        repositoryId: job.repositoryId,
        retryAt: new Date(
          failedAt.getTime() + this.config.failureRetryMs,
        ).toISOString(),
      });
    } catch {
      // Lease expiry provides a second recovery path if failure persistence
      // itself is unavailable. This job must not block unrelated sessions.
      this.logger.error("review job failure persistence failed", {
        code,
        jobId: job.id,
        repositoryId: job.repositoryId,
      });
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
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
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
