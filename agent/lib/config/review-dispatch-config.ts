import {
  validateReviewJobDispatcherConfig,
  type ReviewJobDispatcherConfig,
} from "../application/review-jobs/dispatch-review-jobs.ts";

const DEFAULT_CONFIG: ReviewJobDispatcherConfig = {
  claimLimit: 10,
  concurrencyLimit: 3,
  leaseForMs: 30 * 60_000,
  claimAttempts: 2,
  failureRetryMs: 5 * 60_000,
};

/**
 * Reads bounded review-dispatch controls from runtime environment variables.
 *
 * @returns A fully validated configuration with conservative defaults.
 */
export function loadReviewDispatchConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReviewJobDispatcherConfig {
  return validateReviewJobDispatcherConfig({
    claimLimit: readInteger(
      environment,
      "REVIEW_DISPATCH_CLAIM_LIMIT",
      DEFAULT_CONFIG.claimLimit,
    ),
    concurrencyLimit: readInteger(
      environment,
      "REVIEW_DISPATCH_CONCURRENCY_LIMIT",
      DEFAULT_CONFIG.concurrencyLimit,
    ),
    leaseForMs: readInteger(
      environment,
      "REVIEW_JOB_LEASE_MS",
      DEFAULT_CONFIG.leaseForMs,
    ),
    claimAttempts: readInteger(
      environment,
      "REVIEW_JOB_CLAIM_ATTEMPTS",
      DEFAULT_CONFIG.claimAttempts,
    ),
    failureRetryMs: readInteger(
      environment,
      "REVIEW_JOB_FAILURE_RETRY_MS",
      DEFAULT_CONFIG.failureRetryMs,
    ),
  });
}

function readInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const value = environment[name];
  if (value === undefined) {
    return fallback;
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return Number(value);
}
