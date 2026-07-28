import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewJobContext } from "../../domain/review-jobs/review-job-context.ts";
import {
  AssignedReviewJobLoader,
  AssignedReviewJobUnavailableError,
  type ReviewSessionPrincipal,
  UntrustedReviewSessionError,
} from "./load-assigned-review-job.ts";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("AssignedReviewJobLoader", () => {
  it("loads only the job bound to the app-authenticated session initiator", async () => {
    const requestedIds: string[] = [];
    const context = reviewJobContext();
    const loader = new AssignedReviewJobLoader({
      async loadActive(reviewJobId) {
        requestedIds.push(reviewJobId);
        return context;
      },
    });

    const result = await loader.load({
      current: {
        authenticator: "slack",
        principalId: "U0123456789",
        principalType: "user",
        attributes: { reviewJobId: "attacker-controlled" },
      },
      initiator: appPrincipal(REVIEW_JOB_ID),
    });

    assert.equal(result, context);
    assert.deepEqual(requestedIds, [REVIEW_JOB_ID]);
  });

  it("rejects sessions that were not started by the Eve app principal", async () => {
    const loader = new AssignedReviewJobLoader({
      async loadActive() {
        throw new Error("Store must not be called.");
      },
    });

    await assert.rejects(
      loader.load({
        current: null,
        initiator: {
          authenticator: "slack",
          principalId: "U0123456789",
          principalType: "user",
          attributes: { reviewJobId: REVIEW_JOB_ID },
        },
      }),
      UntrustedReviewSessionError,
    );
  });

  it("rejects missing, array-valued, or invalid job attributes", async () => {
    const loader = new AssignedReviewJobLoader({
      async loadActive() {
        throw new Error("Store must not be called.");
      },
    });

    for (const reviewJobId of [
      undefined,
      [REVIEW_JOB_ID],
      "not-a-uuid",
    ]) {
      await assert.rejects(
        loader.load({
          current: null,
          initiator: appPrincipal(reviewJobId),
        }),
        UntrustedReviewSessionError,
      );
    }
  });

  it("reports when the assigned job is no longer actively leased", async () => {
    const loader = new AssignedReviewJobLoader({
      async loadActive() {
        return null;
      },
    });

    await assert.rejects(
      loader.load({
        current: null,
        initiator: appPrincipal(REVIEW_JOB_ID),
      }),
      AssignedReviewJobUnavailableError,
    );
  });
});

function appPrincipal(
  reviewJobId: string | readonly string[] | undefined,
): ReviewSessionPrincipal {
  const attributes: Record<string, string | readonly string[]> = {};
  if (reviewJobId !== undefined) {
    attributes.reviewJobId = reviewJobId;
  }
  return {
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
    attributes,
  };
}

function reviewJobContext(): ReviewJobContext {
  return {
    reviewJobId: REVIEW_JOB_ID,
    mode: "INCREMENTAL",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    repository: {
      id: "22222222-2222-4222-8222-222222222222",
      fullName: "example/example-service",
      defaultBranch: "main",
    },
    roadie: {
      componentRef: "component:default/example-service",
      systemRef: "system:default/example-system",
      ownerRef: "group:default/example-team",
      slackChannelId: "C0123456789",
      catalogRevision: "revision-1",
      configurationHash: "c".repeat(64),
    },
    documentationScope: [],
  };
}
