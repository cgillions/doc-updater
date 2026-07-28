import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DueReviewJobEnqueuer,
  type DueReviewCandidate,
} from "./enqueue-due-reviews.ts";

describe("DueReviewJobEnqueuer", () => {
  it("enqueues incremental and reconciliation candidates at their SHA baselines", async () => {
    const availableAt = new Date("2026-07-29T07:00:00.000Z");
    const candidates: DueReviewCandidate[] = [
      {
        repositoryId: "11111111-1111-4111-8111-111111111111",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        mode: "INCREMENTAL",
      },
      {
        repositoryId: "22222222-2222-4222-8222-222222222222",
        baseSha: null,
        headSha: "c".repeat(40),
        mode: "RECONCILIATION",
      },
    ];
    const enqueued: unknown[] = [];
    const service = new DueReviewJobEnqueuer(
      { listDueReviewCandidates: async () => candidates },
      {
        async enqueue(input) {
          enqueued.push(input);
          return { id: `job-${enqueued.length}` };
        },
      },
    );

    const result = await service.enqueue(availableAt);

    assert.deepEqual(result, {
      candidateCount: 2,
      jobIds: ["job-1", "job-2"],
    });
    assert.deepEqual(enqueued, [
      { ...candidates[0], availableAt },
      { ...candidates[1], availableAt },
    ]);
  });

  it("does not enqueue when no repository has a changed baseline", async () => {
    let enqueueCalled = false;
    const service = new DueReviewJobEnqueuer(
      { listDueReviewCandidates: async () => [] },
      {
        async enqueue() {
          enqueueCalled = true;
          return { id: "unexpected" };
        },
      },
    );

    assert.deepEqual(
      await service.enqueue(new Date("2026-07-29T07:00:00.000Z")),
      { candidateCount: 0, jobIds: [] },
    );
    assert.equal(enqueueCalled, false);
  });
});
