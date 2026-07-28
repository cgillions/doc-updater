import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewSessionAuth } from "../review-jobs/load-assigned-review-job.ts";
import {
  completeAssignedReviewJob,
  createAssignedChangeProposal,
  recordAssignedDriftEvidence,
} from "./assigned-review-records.ts";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("assigned review record operations", () => {
  it("derives the job ID from the durable app initiator for every operation", async () => {
    const requestedJobIds: string[] = [];
    const auth = scheduledAuth();

    await recordAssignedDriftEvidence(
      auth,
      evidenceInput(),
      {
        async record(reviewJobId) {
          requestedJobIds.push(reviewJobId);
          return { kind: "evidence" };
        },
      },
    );
    await createAssignedChangeProposal(
      auth,
      proposalInput(),
      {
        async create(reviewJobId) {
          requestedJobIds.push(reviewJobId);
          return { kind: "proposal" };
        },
      },
    );
    await completeAssignedReviewJob(
      auth,
      {
        outcome: "in-sync",
        summary: "Documentation matches implementation.",
      },
      {
        async complete(reviewJobId) {
          requestedJobIds.push(reviewJobId);
          return { kind: "completion" };
        },
      },
    );

    assert.deepEqual(requestedJobIds, [
      REVIEW_JOB_ID,
      REVIEW_JOB_ID,
      REVIEW_JOB_ID,
    ]);
  });

  it("rejects untrusted initiators before invoking persistence", async () => {
    let invoked = false;
    const auth: ReviewSessionAuth = {
      current: null,
      initiator: {
        authenticator: "slack",
        principalId: "U0123456789",
        principalType: "user",
        attributes: { reviewJobId: REVIEW_JOB_ID },
      },
    };

    await assert.rejects(
      recordAssignedDriftEvidence(auth, evidenceInput(), {
        async record() {
          invoked = true;
          return {};
        },
      }),
    );
    assert.equal(invoked, false);
  });
});

function scheduledAuth(): ReviewSessionAuth {
  return {
    current: {
      authenticator: "slack",
      principalId: "U0123456789",
      principalType: "user",
      attributes: {
        reviewJobId: "22222222-2222-4222-8222-222222222222",
      },
    },
    initiator: {
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
      attributes: { reviewJobId: REVIEW_JOB_ID },
    },
  };
}

function evidenceInput() {
  return {
    claim: "The endpoint requires an idempotency key.",
    implementationReferences: [{ path: "src/routes/orders.ts" }],
    documentation: {
      kind: "repository" as const,
      path: "docs/orders.md",
    },
    behaviorComparisons: [consistentBehaviorComparison()],
    confidenceReasons: ["The behavior is enforced by the route."],
  };
}

function consistentBehaviorComparison() {
  return {
    behavior: "Order creation requires an idempotency key.",
    base: {
      status: "present" as const,
      excerpt: "The idempotency key is optional.",
    },
    head: {
      status: "present" as const,
      excerpt: "The idempotency key is required.",
    },
    changeDirection: "modified" as const,
    documentationAtHead: {
      claim: "The idempotency key is required.",
      excerpt: "Send an idempotency key with every request.",
    },
    classification: "consistent" as const,
    rationale: "The final-head documentation matches the final behavior.",
  };
}

function proposalInput() {
  return {
    target: {
      kind: "repository" as const,
      path: "docs/orders.md",
    },
    patch: {
      kind: "repository-file-replacement" as const,
      content: "replacement",
    },
    evidenceClaimIds: [
      "33333333-3333-4333-8333-333333333333",
    ],
  };
}
