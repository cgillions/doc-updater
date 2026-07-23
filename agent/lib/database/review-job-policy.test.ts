import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReviewJobDeduplicationKey,
  calculateLeaseExpiry,
  validateBatchSize,
  validateLeaseDuration,
  MAX_REVIEW_JOB_LEASE_MS,
} from "./review-job-policy.ts";

describe("review job policy", () => {
  it("builds a stable key from the repository, SHA range, and mode", () => {
    const input = {
      repositoryId: "3bc7c7bc-04e8-49ab-8e96-85c89b23b784",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      mode: "INCREMENTAL" as const,
    };

    assert.equal(
      buildReviewJobDeduplicationKey(input),
      buildReviewJobDeduplicationKey(input),
    );
    assert.notEqual(
      buildReviewJobDeduplicationKey(input),
      buildReviewJobDeduplicationKey({ ...input, baseSha: null }),
    );
  });

  it("accepts only bounded positive batch sizes", () => {
    assert.equal(validateBatchSize(1), 1);
    assert.equal(validateBatchSize(100), 100);
    assert.throws(() => validateBatchSize(0), /between 1 and 100/);
    assert.throws(() => validateBatchSize(101), /between 1 and 100/);
    assert.throws(() => validateBatchSize(1.5), /integer/);
  });

  it("requires a positive finite lease duration", () => {
    const now = new Date("2026-07-22T09:00:00.000Z");

    assert.deepEqual(
      calculateLeaseExpiry(now, 30_000),
      new Date("2026-07-22T09:00:30.000Z"),
    );
    assert.throws(() => calculateLeaseExpiry(now, 0), /positive/);
    assert.throws(() => calculateLeaseExpiry(now, 1.5), /integer/);
    assert.throws(() => calculateLeaseExpiry(now, Number.POSITIVE_INFINITY), /finite/);
  });

  it("rejects negative, NaN, and over-maximum lease durations", () => {
    assert.throws(() => validateLeaseDuration(-1), /positive/);
    assert.throws(() => validateLeaseDuration(Number.NaN), /finite/);
    assert.throws(
      () => validateLeaseDuration(MAX_REVIEW_JOB_LEASE_MS + 1),
      /must not exceed/,
    );
    assert.throws(
      () => validateLeaseDuration(Number.NEGATIVE_INFINITY),
      /finite/,
    );
    assert.equal(validateLeaseDuration(1), 1);
    assert.equal(validateLeaseDuration(MAX_REVIEW_JOB_LEASE_MS), MAX_REVIEW_JOB_LEASE_MS);
  });
});
