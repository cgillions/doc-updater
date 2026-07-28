import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadReviewDispatchConfig } from "./review-dispatch-config.ts";

describe("loadReviewDispatchConfig", () => {
  it("uses conservative production defaults", () => {
    assert.deepEqual(loadReviewDispatchConfig({}), {
      claimLimit: 10,
      concurrencyLimit: 3,
      leaseForMs: 1_800_000,
      claimAttempts: 2,
      failureRetryMs: 300_000,
    });
  });

  it("loads independently configurable claim and concurrency limits", () => {
    assert.deepEqual(
      loadReviewDispatchConfig({
        REVIEW_DISPATCH_CLAIM_LIMIT: "20",
        REVIEW_DISPATCH_CONCURRENCY_LIMIT: "4",
        REVIEW_JOB_LEASE_MS: "3600000",
        REVIEW_JOB_CLAIM_ATTEMPTS: "3",
        REVIEW_JOB_FAILURE_RETRY_MS: "600000",
      }),
      {
        claimLimit: 20,
        concurrencyLimit: 4,
        leaseForMs: 3_600_000,
        claimAttempts: 3,
        failureRetryMs: 600_000,
      },
    );
  });

  it("rejects malformed or unsafe limits", () => {
    for (const environment of [
      { REVIEW_DISPATCH_CLAIM_LIMIT: "not-a-number" },
      {
        REVIEW_DISPATCH_CLAIM_LIMIT: "2",
        REVIEW_DISPATCH_CONCURRENCY_LIMIT: "3",
      },
      { REVIEW_JOB_CLAIM_ATTEMPTS: "0" },
      { REVIEW_JOB_FAILURE_RETRY_MS: "-1" },
      { REVIEW_JOB_FAILURE_RETRY_MS: "2147483648" },
    ]) {
      assert.throws(() => loadReviewDispatchConfig(environment));
    }
  });
});
