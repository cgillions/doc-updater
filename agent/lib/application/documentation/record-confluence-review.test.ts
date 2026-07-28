import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import type { StoredConfluenceCandidate } from "../../database/confluence-page-store.ts";
import { hashConfluenceBody } from "../../domain/documentation/confluence-page.ts";
import { AssignedConfluenceReviewRecorder } from "./record-confluence-review.ts";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = "123e4567-e89b-42d3-a456-426614174001";
const EVIDENCE_ID = "123e4567-e89b-42d3-a456-426614174002";
const STORAGE = "<h2>Orders</h2><p>Retries are automatic.</p>";
const AUTH = {
  current: null,
  initiator: {
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
    attributes: { reviewJobId: JOB_ID },
  },
};

describe("AssignedConfluenceReviewRecorder", () => {
  it("derives evidence page identity and baseline from the fetched candidate", async () => {
    const calls: unknown[] = [];
    const recorder = new AssignedConfluenceReviewRecorder({
      loadCandidate: async () => candidate(),
    });

    await recorder.recordEvidence(
      AUTH,
      {
        candidateId: CANDIDATE_ID,
        claim: "Retry behavior is outdated.",
        implementationReferences: [{ path: "src/retry.ts" }],
        confidenceReasons: ["The implementation disables retries."],
      },
      {
        async record(reviewJobId, input) {
          calls.push({ reviewJobId, input });
          return { id: EVIDENCE_ID };
        },
      },
    );

    assert.deepEqual(calls, [{
      reviewJobId: JOB_ID,
      input: {
        claim: "Retry behavior is outdated.",
        implementationReferences: [{ path: "src/retry.ts" }],
        confidenceReasons: ["The implementation disables retries."],
        documentation: {
          kind: "confluence",
          siteId: "example.atlassian.net",
          pageId: "12345",
          version: 7,
          bodyHash: "d".repeat(64),
        },
      },
    }]);
  });

  it("creates an exact-fragment replacement bound to the fetched baseline", async () => {
    const calls: unknown[] = [];
    const baselineStorageValue =
      "<h2>Orders</h2><p>Retries are automatic.</p>";
    const recorder = new AssignedConfluenceReviewRecorder({
      loadCandidate: async () => candidate(),
    });

    await recorder.createProposal(
      AUTH,
      {
        candidateId: CANDIDATE_ID,
        baselineStorageValue,
        replacementStorageValue:
          "<h2>Orders</h2><p>Retries are disabled.</p>",
        evidenceClaimIds: [EVIDENCE_ID],
      },
      {
        async create(reviewJobId, input) {
          calls.push({ reviewJobId, input });
          return { id: "proposal" };
        },
      },
    );

    assert.deepEqual(calls, [{
      reviewJobId: JOB_ID,
      input: {
        target: {
          kind: "confluence",
          siteId: "example.atlassian.net",
          pageId: "12345",
          version: 7,
          bodyHash: "d".repeat(64),
        },
        patch: {
          kind: "confluence-storage-fragment-replacement",
          baselineStorageValue,
          baselineFragmentHash: hashConfluenceBody(
            baselineStorageValue,
          ),
          replacementStorageValue:
            "<h2>Orders</h2><p>Retries are disabled.</p>",
        },
        evidenceClaimIds: [EVIDENCE_ID],
      },
    }]);
  });

  it("rejects unfetched candidates and missing baseline fragments", async () => {
    const unfetched = new AssignedConfluenceReviewRecorder({
      loadCandidate: async () => ({ ...candidate(), snapshot: null }),
    });
    await assert.rejects(
      unfetched.recordEvidence(
        AUTH,
        {
          candidateId: CANDIDATE_ID,
          claim: "Claim",
          implementationReferences: [{ path: "src/retry.ts" }],
          confidenceReasons: ["Reason"],
        },
        { record: async () => undefined },
      ),
      ReviewRecordConflictError,
    );

    const fetched = new AssignedConfluenceReviewRecorder({
      loadCandidate: async () => candidate(),
    });
    await assert.rejects(
      fetched.createProposal(
        AUTH,
        {
          candidateId: CANDIDATE_ID,
          baselineStorageValue: "<p>Missing</p>",
          replacementStorageValue: "<p>Replacement</p>",
          evidenceClaimIds: [EVIDENCE_ID],
        },
        { create: async () => undefined },
      ),
      ReviewRecordConflictError,
    );
  });

  it("rejects a baseline fragment that occurs more than once", async () => {
    const recorder = new AssignedConfluenceReviewRecorder({
      loadCandidate: async () => ({
        ...candidate(),
        snapshot: {
          ...candidate().snapshot!,
          bodyStorageValue: "<p>Repeated</p><p>Repeated</p>",
        },
      }),
    });

    await assert.rejects(
      recorder.createProposal(
        AUTH,
        {
          candidateId: CANDIDATE_ID,
          baselineStorageValue: "<p>Repeated</p>",
          replacementStorageValue: "<p>Replacement</p>",
          evidenceClaimIds: [EVIDENCE_ID],
        },
        { create: async () => undefined },
      ),
      ReviewRecordConflictError,
    );
  });
});

function candidate(): StoredConfluenceCandidate {
  return {
    id: CANDIDATE_ID,
    reviewJobId: JOB_ID,
    siteId: "example.atlassian.net",
    pageId: "12345",
    label: "Orders",
    snapshot: {
      id: "123e4567-e89b-42d3-a456-426614174003",
      siteId: "example.atlassian.net",
      pageId: "12345",
      version: 7,
      title: "Orders",
      bodyStorageValue: STORAGE,
      bodyHash: "d".repeat(64),
    },
  };
}
