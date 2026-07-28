import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChangeProposalDigest,
  buildEvidenceClaimDigest,
  changeProposalInputSchema,
  recordDriftEvidenceInputSchema,
} from "./review-records.ts";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const HEAD_SHA = "a".repeat(40);

describe("review record contracts", () => {
  it("builds stable evidence digests independent of object key order", () => {
    const input = recordDriftEvidenceInputSchema.parse({
      claim: "The public endpoint now requires an idempotency key.",
      implementationReferences: [
        { path: "src/routes/orders.ts", startLine: 20, endLine: 28 },
      ],
      documentation: {
        kind: "repository",
        path: "docs/orders.md",
      },
      confidenceReasons: ["The behavior is enforced and covered by a test."],
    });

    assert.equal(
      buildEvidenceClaimDigest(REVIEW_JOB_ID, HEAD_SHA, input),
      buildEvidenceClaimDigest(REVIEW_JOB_ID, HEAD_SHA, {
        confidenceReasons: input.confidenceReasons,
        documentation: input.documentation,
        implementationReferences: input.implementationReferences,
        claim: input.claim,
      }),
    );
  });

  it("rejects paths that can escape the assigned repository", () => {
    for (const path of [
      "../docs/orders.md",
      "/docs/orders.md",
      "docs\\orders.md",
    ]) {
      assert.throws(() =>
        recordDriftEvidenceInputSchema.parse({
          claim: "A factual claim.",
          implementationReferences: [{ path: "src/orders.ts" }],
          documentation: { kind: "repository", path },
          confidenceReasons: ["A confidence reason."],
        }),
      );
    }
  });

  it("binds proposal digests to the job, baseline, patch, and evidence", () => {
    const input = changeProposalInputSchema.parse({
      target: { kind: "repository", path: "docs/orders.md" },
      patch: {
        kind: "repository-file-replacement",
        content: "# Orders\n\nSend an idempotency key.",
      },
      evidenceClaimIds: [EVIDENCE_ID],
    });

    const digest = buildChangeProposalDigest(
      REVIEW_JOB_ID,
      HEAD_SHA,
      input,
    );

    assert.notEqual(
      digest,
      buildChangeProposalDigest(
        REVIEW_JOB_ID,
        "b".repeat(40),
        input,
      ),
    );
    assert.equal(
      digest,
      buildChangeProposalDigest(REVIEW_JOB_ID, HEAD_SHA, {
        ...input,
        evidenceClaimIds: [...input.evidenceClaimIds].reverse(),
      }),
    );
  });

  it("requires the patch format to match the target kind", () => {
    assert.throws(() =>
      changeProposalInputSchema.parse({
        target: {
          kind: "confluence",
          siteId: "example-site",
          pageId: "12345",
          version: 7,
          bodyHash: "c".repeat(64),
        },
        patch: {
          kind: "repository-file-replacement",
          content: "replacement",
        },
        evidenceClaimIds: [EVIDENCE_ID],
      }),
    );
  });
});
