import {
  Prisma,
  type ReviewJob,
  type PrismaClient,
} from "./generated/client.ts";
import type { ReviewJobMode } from "./generated/enums.ts";
import {
  ReviewJobClaimConflictError,
  ReviewJobLeaseConflictError,
  ReviewJobNotFoundError,
} from "../domain/review-jobs/errors.ts";
import {
  buildReviewJobDeduplicationKey,
  buildReviewJobRangeKey,
  calculateLeaseExpiry,
  validateBatchSize,
  validateLeaseDuration,
} from "../domain/review-jobs/review-job-policy.ts";

/** Values required to enqueue one immutable repository review range. */
export interface EnqueueReviewJobInput {
  repositoryId: string;
  baseSha: string | null;
  headSha: string;
  mode: ReviewJobMode;
  availableAt?: Date;
}

/** Parameters for one idempotent, bounded claim invocation. */
export interface ClaimDueInput {
  /** Stable UUID created once and reused whenever this claim call is retried. */
  claimId: string;
  /** Identifier recorded as the lease owner and audit actor. */
  workerId: string;
  limit: number;
  leaseForMs: number;
  now?: Date;
}

/** Lease-bound completion request. */
export interface CompleteReviewJobInput {
  jobId: string;
  leaseToken: string;
  completedAt?: Date;
}

/** Lease-bound failure request. Supplying `retryAt` requeues the job. */
export interface FailReviewJobInput {
  jobId: string;
  leaseToken: string;
  code: string;
  message: string;
  failedAt?: Date;
  retryAt?: Date;
}

/** Bounds one expired-lease recovery pass. */
export interface RecoverExpiredLeasesInput {
  limit: number;
  now?: Date;
}

interface ClaimedJobRow {
  id: string;
}

interface ClaimInvocationRow {
  id: string;
}

interface RecoveredJobRow {
  id: string;
  repositoryId: string;
  lastLeaseToken: string;
}

/** A review job whose active lease fields are guaranteed to be present. */
export type ClaimedReviewJob = ReviewJob & {
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

/**
 * Durable queue operations for repository review jobs.
 *
 * Every state transition and its audit event run in the same transaction.
 * Callers must retain claim IDs and lease tokens across retries.
 */
export class ReviewJobStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Enqueues a review unless its range already has a current attempt.
   *
   * A completed incomplete attempt permits one new job for the same immutable
   * range. The advisory lock serializes concurrent enqueue decisions without
   * mutating or discarding the prior attempt's evidence and audit history.
   *
   * @returns The new or previously enqueued job.
   */
  async enqueue(input: EnqueueReviewJobInput): Promise<ReviewJob> {
    const rangeKey = buildReviewJobRangeKey(input);

    return this.database.$transaction(async (transaction) => {
      const availableAt = input.availableAt ?? new Date();
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${rangeKey}, 0)
        )::text AS locked
      `);
      const latestAttempt = await transaction.reviewJob.findFirst({
        where: {
          repositoryId: input.repositoryId,
          baseSha: input.baseSha,
          headSha: input.headSha,
          mode: input.mode,
        },
        orderBy: { attemptNumber: "desc" },
      });
      if (
        latestAttempt &&
        !(
          latestAttempt.status === "COMPLETED" &&
          latestAttempt.outcome === "INCOMPLETE"
        )
      ) {
        return latestAttempt;
      }
      const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
      const deduplicationKey = buildReviewJobDeduplicationKey(
        input,
        attemptNumber,
      );
      const job = await transaction.reviewJob.create({
        data: {
          repositoryId: input.repositoryId,
          baseSha: input.baseSha,
          headSha: input.headSha,
          mode: input.mode,
          deduplicationKey,
          attemptNumber,
          availableAt,
        },
      });

      await recordAuditEvent(transaction, {
        repositoryId: job.repositoryId,
        reviewJobId: job.id,
        eventType: "review_job_enqueued",
        idempotencyKey: `review-job-enqueued:${deduplicationKey}`,
        details: {
          baseSha: job.baseSha,
          headSha: job.headSha,
          mode: job.mode,
          attemptNumber: job.attemptNumber,
        },
      });
      return job;
    });
  }

  /**
   * Leases a bounded batch of due jobs for one claim invocation.
   *
   * Reusing `claimId` returns that invocation's jobs that remain leased and
   * never leases additional work. The same ID cannot be reused with different
   * worker, limit, or lease-duration values.
   *
   * @returns Newly claimed jobs, replayed active leases, or an empty array.
   * @throws {ReviewJobClaimConflictError} If the claim ID parameters differ.
   */
  async claimDue(input: ClaimDueInput): Promise<ClaimedReviewJob[]> {
    const limit = validateBatchSize(input.limit);
    const leaseDurationMs = validateLeaseDuration(input.leaseForMs);
    const now = input.now ?? new Date();
    const leaseExpiresAt = calculateLeaseExpiry(now, leaseDurationMs);
    if (input.workerId.length === 0) {
      throw new Error("A worker ID is required to claim review jobs.");
    }

    return this.database.$transaction(async (transaction) => {
      const [createdInvocation] = await transaction.$queryRaw<
        ClaimInvocationRow[]
      >(Prisma.sql`
        INSERT INTO review_job_claim_invocations (
          id,
          worker_id,
          requested_limit,
          lease_duration_ms,
          created_at
        )
        VALUES (
          ${input.claimId}::uuid,
          ${input.workerId},
          ${limit},
          ${leaseDurationMs},
          ${now}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);

      if (!createdInvocation) {
        return loadClaimInvocationReplay(transaction, {
          claimId: input.claimId,
          workerId: input.workerId,
          limit,
          leaseDurationMs,
        });
      }

      const claimedRows = await transaction.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
        WITH claimable AS (
          SELECT jobs.id
          FROM review_jobs AS jobs
          INNER JOIN repository_registry AS repositories
            ON repositories.id = jobs.repository_id
          WHERE jobs.status = 'PENDING'::"ReviewJobStatus"
            AND jobs.available_at <= ${now}
            AND repositories.is_accessible = true
            AND repositories.is_archived = false
            AND repositories.is_paused = false
          ORDER BY jobs.available_at, jobs.created_at, jobs.id
          FOR UPDATE OF jobs SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE review_jobs AS jobs
        SET status = 'LEASED'::"ReviewJobStatus",
            attempt_count = jobs.attempt_count + 1,
            claim_invocation_id = ${input.claimId}::uuid,
            lease_owner = ${input.workerId},
            lease_token = gen_random_uuid(),
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        FROM claimable
        WHERE jobs.id = claimable.id
        RETURNING jobs.id
      `);

      if (claimedRows.length === 0) {
        return [];
      }

      const jobs = await transaction.reviewJob.findMany({
        where: { id: { in: claimedRows.map((row) => row.id) } },
      });
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      const claimedJobs = claimedRows.map((row) => {
        const job = jobsById.get(row.id);
        if (!isClaimedReviewJob(job)) {
          throw new Error(`Claimed review job ${row.id} has invalid lease state.`);
        }
        return job;
      });

      for (const job of claimedJobs) {
        await recordAuditEvent(transaction, {
          repositoryId: job.repositoryId,
          reviewJobId: job.id,
          eventType: "review_job_claimed",
          idempotencyKey: `review-job-claimed:${job.id}:${job.leaseToken}`,
          actorId: input.workerId,
          details: {
            attemptCount: job.attemptCount,
            claimId: input.claimId,
            leaseExpiresAt: job.leaseExpiresAt.toISOString(),
          },
        });
      }
      return claimedJobs;
    });
  }

  /**
   * Checks whether the supplied lease produced a persisted review outcome.
   *
   * @returns `true` only after `complete_review_job` completed this exact lease.
   */
  async hasRecordedOutcome(
    jobId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const job = await this.database.reviewJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        outcome: true,
        lastLeaseToken: true,
        lastLeaseOutcome: true,
      },
    });
    return (
      job?.status === "COMPLETED" &&
      job.outcome !== null &&
      job.lastLeaseToken === leaseToken &&
      job.lastLeaseOutcome === "COMPLETED"
    );
  }

  /**
   * Completes the job held by the supplied lease token.
   *
   * Replaying the same successful transition returns the completed job.
   *
   * @returns The completed job.
   * @throws {ReviewJobNotFoundError} If the job does not exist.
   * @throws {ReviewJobLeaseConflictError} If another lease owns the job.
   */
  async complete(input: CompleteReviewJobInput): Promise<ReviewJob> {
    const completedAt = input.completedAt ?? new Date();

    return this.database.$transaction(async (transaction) => {
      const update = await transaction.reviewJob.updateMany({
        where: {
          id: input.jobId,
          status: "LEASED",
          leaseToken: input.leaseToken,
        },
        data: {
          status: "COMPLETED",
          leaseOwner: null,
          leaseToken: null,
          lastLeaseToken: input.leaseToken,
          lastLeaseOutcome: "COMPLETED",
          leaseExpiresAt: null,
          completedAt,
          failedAt: null,
          lastFailureCode: null,
          lastFailureMessage: null,
        },
      });

      const job = await loadTransitionResult(
        transaction,
        input.jobId,
        update.count,
        (existing) =>
          existing.status === "COMPLETED" &&
          existing.lastLeaseToken === input.leaseToken &&
          existing.lastLeaseOutcome === "COMPLETED",
      );
      await recordAuditEvent(transaction, {
        repositoryId: job.repositoryId,
        reviewJobId: job.id,
        eventType: "review_job_completed",
        idempotencyKey: `review-job-completed:${job.id}:${input.leaseToken}`,
        details: { completedAt: job.completedAt?.toISOString() ?? null },
      });
      return job;
    });
  }

  /**
   * Records a leased job failure and either requeues or terminates it.
   *
   * Supplying `retryAt` returns the job to `PENDING`; omitting it marks the job
   * `FAILED`. Replaying the same transition returns its existing result.
   *
   * @returns The requeued or terminally failed job.
   * @throws {ReviewJobNotFoundError} If the job does not exist.
   * @throws {ReviewJobLeaseConflictError} If another lease owns the job.
   */
  async fail(input: FailReviewJobInput): Promise<ReviewJob> {
    const failedAt = input.failedAt ?? new Date();
    if (input.retryAt && input.retryAt < failedAt) {
      throw new RangeError("Retry time cannot be earlier than failure time.");
    }
    if (input.code.length === 0 || input.message.length === 0) {
      throw new Error("Failure code and message are required.");
    }

    const willRetry = input.retryAt !== undefined;
    return this.database.$transaction(async (transaction) => {
      const update = await transaction.reviewJob.updateMany({
        where: {
          id: input.jobId,
          status: "LEASED",
          leaseToken: input.leaseToken,
        },
        data: {
          status: willRetry ? "PENDING" : "FAILED",
          availableAt: input.retryAt,
          leaseOwner: null,
          leaseToken: null,
          lastLeaseToken: input.leaseToken,
          lastLeaseOutcome: "FAILED",
          leaseExpiresAt: null,
          completedAt: null,
          failedAt: willRetry ? null : failedAt,
          lastFailureCode: input.code,
          lastFailureMessage: input.message,
        },
      });

      const job = await loadTransitionResult(
        transaction,
        input.jobId,
        update.count,
        (existing) =>
          (existing.status === "PENDING" || existing.status === "FAILED") &&
          existing.lastLeaseToken === input.leaseToken &&
          existing.lastLeaseOutcome === "FAILED",
      );
      await recordAuditEvent(transaction, {
        repositoryId: job.repositoryId,
        reviewJobId: job.id,
        eventType: "review_job_failed",
        idempotencyKey: `review-job-failed:${job.id}:${input.leaseToken}`,
        details: {
          code: input.code,
          failedAt: failedAt.toISOString(),
          retryAt: input.retryAt?.toISOString() ?? null,
        },
      });
      return job;
    });
  }

  /**
   * Releases a bounded set of expired leases for later claims.
   *
   * @returns Jobs recovered by this invocation; already recovered jobs are not
   * returned again.
   */
  async recoverExpiredLeases(
    input: RecoverExpiredLeasesInput,
  ): Promise<ReviewJob[]> {
    const limit = validateBatchSize(input.limit);
    const now = input.now ?? new Date();

    return this.database.$transaction(async (transaction) => {
      const recoveredRows = await transaction.$queryRaw<RecoveredJobRow[]>(
        Prisma.sql`
          WITH expired AS (
            SELECT id
            FROM review_jobs
            WHERE status = 'LEASED'::"ReviewJobStatus"
              AND lease_expires_at <= ${now}
            ORDER BY lease_expires_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE review_jobs AS jobs
          SET status = 'PENDING'::"ReviewJobStatus",
              available_at = ${now},
              lease_owner = NULL,
              last_lease_token = jobs.lease_token,
              last_lease_outcome = 'RECOVERED'::"ReviewLeaseOutcome",
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ${now}
          FROM expired
          WHERE jobs.id = expired.id
          RETURNING jobs.id,
                    jobs.repository_id AS "repositoryId",
                    jobs.last_lease_token AS "lastLeaseToken"
        `,
      );

      for (const row of recoveredRows) {
        await recordAuditEvent(transaction, {
          repositoryId: row.repositoryId,
          reviewJobId: row.id,
          eventType: "review_job_lease_recovered",
          idempotencyKey: `review-job-lease-recovered:${row.id}:${row.lastLeaseToken}`,
          details: { recoveredAt: now.toISOString() },
        });
      }

      const jobs = await transaction.reviewJob.findMany({
        where: { id: { in: recoveredRows.map((row) => row.id) } },
      });
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      return recoveredRows.map((row) => {
        const job = jobsById.get(row.id);
        if (!job) {
          throw new Error(`Recovered review job ${row.id} could not be loaded.`);
        }
        return job;
      });
    });
  }
}

interface ClaimInvocationIdentity {
  claimId: string;
  workerId: string;
  limit: number;
  leaseDurationMs: number;
}

/** Loads active leases for an existing claim after validating key reuse. */
async function loadClaimInvocationReplay(
  transaction: Prisma.TransactionClient,
  identity: ClaimInvocationIdentity,
): Promise<ClaimedReviewJob[]> {
  const invocation = await transaction.reviewJobClaimInvocation.findUniqueOrThrow({
    where: { id: identity.claimId },
  });
  if (
    invocation.workerId !== identity.workerId ||
    invocation.requestedLimit !== identity.limit ||
    invocation.leaseDurationMs !== identity.leaseDurationMs
  ) {
    throw new ReviewJobClaimConflictError(identity.claimId);
  }

  const jobs = await transaction.reviewJob.findMany({
    where: {
      claimInvocationId: identity.claimId,
      status: "LEASED",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return jobs.map((job) => {
    if (!isClaimedReviewJob(job)) {
      throw new Error(`Replayed review job ${job.id} has invalid lease state.`);
    }
    return job;
  });
}

/** Narrows a persisted job to the active-lease return contract. */
function isClaimedReviewJob(job: ReviewJob | undefined): job is ClaimedReviewJob {
  return (
    job?.status === "LEASED" &&
    job.leaseOwner !== null &&
    job.leaseToken !== null &&
    job.leaseExpiresAt !== null
  );
}

/** Loads a transition result while accepting an exact idempotent replay. */
async function loadTransitionResult(
  transaction: Prisma.TransactionClient,
  jobId: string,
  updatedCount: number,
  isReplay: (job: ReviewJob) => boolean,
): Promise<ReviewJob> {
  const job = await transaction.reviewJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new ReviewJobNotFoundError(jobId);
  }
  if (updatedCount === 0 && !isReplay(job)) {
    throw new ReviewJobLeaseConflictError(jobId);
  }
  return job;
}

interface AuditEventInput {
  repositoryId: string;
  reviewJobId: string;
  eventType: string;
  idempotencyKey: string;
  actorId?: string;
  details: Prisma.InputJsonObject;
}

/** Inserts an immutable event, ignoring an exact idempotency-key replay. */
async function recordAuditEvent(
  transaction: Prisma.TransactionClient,
  input: AuditEventInput,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO audit_events (
      id,
      repository_id,
      review_job_id,
      event_type,
      idempotency_key,
      actor_id,
      details,
      created_at
    )
    VALUES (
      gen_random_uuid(),
      ${input.repositoryId}::uuid,
      ${input.reviewJobId}::uuid,
      ${input.eventType},
      ${input.idempotencyKey},
      ${input.actorId ?? null},
      ${JSON.stringify(input.details)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `);
}
