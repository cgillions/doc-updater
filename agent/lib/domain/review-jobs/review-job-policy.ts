import { createHash } from "node:crypto";

import type { ReviewJobMode } from "../../database/generated/enums.ts";

/** Maximum number of jobs one database claim may lease. */
export const MAX_REVIEW_JOB_BATCH_SIZE = 100;
/** Maximum lease duration supported by the persisted millisecond field. */
export const MAX_REVIEW_JOB_LEASE_MS = 2_147_483_647;

/** Fields that uniquely identify one repository review. */
export interface ReviewJobIdentity {
  repositoryId: string;
  baseSha: string | null;
  headSha: string;
  mode: ReviewJobMode;
}

/**
 * Builds the stable key used to deduplicate review-job enqueue operations.
 *
 * @returns A versioned SHA-256 digest of the repository, SHA range, and mode.
 */
export function buildReviewJobDeduplicationKey(
  identity: ReviewJobIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "review-job-v1",
        identity.repositoryId,
        identity.baseSha,
        identity.headSha,
        identity.mode,
      ]),
    )
    .digest("hex");
}

/**
 * Validates a requested claim size.
 *
 * @returns The validated limit for direct use in a query.
 * @throws {RangeError} If the limit is not an integer from 1 to 100.
 */
export function validateBatchSize(limit: number): number {
  if (!Number.isInteger(limit)) {
    throw new RangeError("Review job batch size must be an integer.");
  }
  if (limit < 1 || limit > MAX_REVIEW_JOB_BATCH_SIZE) {
    throw new RangeError(
      `Review job batch size must be between 1 and ${MAX_REVIEW_JOB_BATCH_SIZE}.`,
    );
  }
  return limit;
}

/**
 * Calculates when a lease expires.
 *
 * @returns A new date offset from `now` by the validated duration.
 */
export function calculateLeaseExpiry(now: Date, leaseForMs: number): Date {
  const duration = validateLeaseDuration(leaseForMs);
  return new Date(now.getTime() + duration);
}

/**
 * Validates a lease duration before it is persisted.
 *
 * @returns The validated duration in milliseconds.
 * @throws {RangeError} If the duration is non-finite, fractional, or out of range.
 */
export function validateLeaseDuration(leaseForMs: number): number {
  if (!Number.isFinite(leaseForMs)) {
    throw new RangeError("Lease duration must be finite.");
  }
  if (!Number.isInteger(leaseForMs)) {
    throw new RangeError("Lease duration must be an integer number of milliseconds.");
  }
  if (leaseForMs <= 0) {
    throw new RangeError("Lease duration must be positive.");
  }
  if (leaseForMs > MAX_REVIEW_JOB_LEASE_MS) {
    throw new RangeError(`Lease duration must not exceed ${MAX_REVIEW_JOB_LEASE_MS}.`);
  }
  return leaseForMs;
}
