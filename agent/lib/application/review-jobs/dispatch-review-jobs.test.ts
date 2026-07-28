import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReviewJobDispatcher,
  type DispatchableReviewJob,
  type ReviewJobDispatcherConfig,
} from "./dispatch-review-jobs.ts";

const NOW = new Date("2026-07-29T07:00:00.000Z");
const LEASE_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("ReviewJobDispatcher", () => {
  it("reuses one claim ID after a lost claim response", async () => {
    const claimIds: string[] = [];
    let claimAttempt = 0;
    const job = claimedJob("job-1", "repository-1");
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 1, jobIds: [job.id] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue(input) {
          claimIds.push(input.claimId);
          claimAttempt += 1;
          if (claimAttempt === 1) {
            throw new Error("Response was lost.");
          }
          return [job];
        },
        async complete() {
          return {};
        },
        async fail() {
          return {};
        },
      },
      routes: {
        loadDispatchRoutes: async () => [
          { reviewJobId: job.id, slackChannelId: "C0123456789" },
        ],
      },
      receiver: {
        start: async () => ({ sessionId: "session-1" }),
      },
      config: dispatcherConfig(),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.deepEqual(claimIds, ["claim-id", "claim-id"]);
    assert.equal(result.claimId, "claim-id");
    assert.equal(result.workerId, "worker-id");
    assert.deepEqual(result.sessionIds, ["session-1"]);
  });

  it("separates claim size from bounded session concurrency", async () => {
    const jobs = [
      claimedJob("job-1", "repository-1"),
      claimedJob("job-2", "repository-2"),
      claimedJob("job-3", "repository-3"),
    ];
    let requestedLimit = 0;
    let activeSessions = 0;
    let maximumConcurrency = 0;
    const completed: string[] = [];
    const failed: string[] = [];
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 3, jobIds: [] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [claimedJob("recovered", "repository-old")];
        },
        async claimDue(input) {
          requestedLimit = input.limit;
          return jobs;
        },
        async complete(input) {
          completed.push(input.jobId);
          return {};
        },
        async fail(input) {
          failed.push(input.jobId);
          return {};
        },
      },
      routes: {
        loadDispatchRoutes: async () =>
          jobs.map((job) => ({
            reviewJobId: job.id,
            slackChannelId: `C${job.id.at(-1)!.repeat(10)}`,
          })),
      },
      receiver: {
        async start({ reviewJobId }) {
          activeSessions += 1;
          maximumConcurrency = Math.max(
            maximumConcurrency,
            activeSessions,
          );
          await Promise.resolve();
          activeSessions -= 1;
          if (reviewJobId === "job-2") {
            throw new Error("Session failed.");
          }
          return { sessionId: `session-${reviewJobId}` };
        },
      },
      config: dispatcherConfig({ claimLimit: 5, concurrencyLimit: 2 }),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.equal(requestedLimit, 5);
    assert.equal(maximumConcurrency, 2);
    assert.deepEqual(completed.sort(), ["job-1", "job-3"]);
    assert.deepEqual(failed, ["job-2"]);
    assert.deepEqual(result, {
      claimId: "claim-id",
      workerId: "worker-id",
      candidateCount: 3,
      recoveredLeaseCount: 1,
      claimedCount: 3,
      completedCount: 2,
      failedCount: 1,
      sessionIds: ["session-job-1", "session-job-3"],
    });
  });

  it("fails only the job whose Slack route is unavailable", async () => {
    const jobs = [
      claimedJob("job-1", "repository-1"),
      claimedJob("job-2", "repository-2"),
    ];
    const completed: string[] = [];
    const failures: Array<{ code: string; jobId: string }> = [];
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 2, jobIds: [] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue() {
          return jobs;
        },
        async complete(input) {
          completed.push(input.jobId);
          return {};
        },
        async fail(input) {
          failures.push({ code: input.code, jobId: input.jobId });
          return {};
        },
      },
      routes: {
        loadDispatchRoutes: async () => [
          { reviewJobId: "job-1", slackChannelId: "C0123456789" },
        ],
      },
      receiver: {
        start: async ({ reviewJobId }) => ({
          sessionId: `session-${reviewJobId}`,
        }),
      },
      config: dispatcherConfig(),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.deepEqual(completed, ["job-1"]);
    assert.deepEqual(failures, [
      { code: "SLACK_ROUTE_UNAVAILABLE", jobId: "job-2" },
    ]);
    assert.equal(result.completedCount, 1);
    assert.equal(result.failedCount, 1);
  });
});

function claimedJob(
  id: string,
  repositoryId: string,
): DispatchableReviewJob {
  return { id, repositoryId, leaseToken: LEASE_TOKEN };
}

function dispatcherConfig(
  overrides: Partial<ReviewJobDispatcherConfig> = {},
): ReviewJobDispatcherConfig {
  return {
    claimLimit: 10,
    concurrencyLimit: 2,
    leaseForMs: 30 * 60_000,
    claimAttempts: 2,
    failureRetryMs: 5 * 60_000,
    ...overrides,
  };
}

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `unexpected-${index}`;
}
