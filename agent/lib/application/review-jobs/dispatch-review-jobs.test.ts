import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ReviewJobDispatcher,
  type DispatchableReviewJob,
  type ReviewJobDispatcherConfig,
} from "./dispatch-review-jobs.ts";
import type {
  LogAttributes,
  Logger,
  LogLevel,
} from "../../observability/logger.ts";
import { setLoggerForTesting } from "../../observability/logger.ts";

const NOW = new Date("2026-07-29T07:00:00.000Z");
const LEASE_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("ReviewJobDispatcher", () => {
  beforeEach(() => {
    setLoggerForTesting(captureLogger([]));
  });

  afterEach(() => {
    setLoggerForTesting(undefined);
  });

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
        async hasRecordedOutcome() {
          return true;
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
        start: async () => ({
          sessionId: "session-1",
          settlement: "completed",
        }),
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
        async hasRecordedOutcome(jobId) {
          completed.push(jobId);
          return true;
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
          return {
            sessionId: `session-${reviewJobId}`,
            settlement: "completed",
          };
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
      waitingCount: 0,
      failedCount: 1,
      sessionIds: ["session-job-1", "session-job-3"],
    });
  });

  it("dispatches each claimed job once under concurrency", async () => {
    const jobs = [
      claimedJob("job-1", "repository-1"),
      claimedJob("job-2", "repository-2"),
      claimedJob("job-3", "repository-3"),
      claimedJob("job-4", "repository-4"),
    ];
    let releaseSessionStart!: () => void;
    const sessionStarted = new Promise<void>((resolve) => {
      releaseSessionStart = resolve;
    });
    const startedJobs: string[] = [];
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 4, jobIds: [] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue() {
          return jobs;
        },
        async hasRecordedOutcome() {
          return true;
        },
        async fail() {
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
          startedJobs.push(reviewJobId);
          if (startedJobs.length === 2) {
            releaseSessionStart();
          }
          await sessionStarted;
          return {
            sessionId: `session-${reviewJobId}`,
            settlement: "completed",
          };
        },
      },
      config: dispatcherConfig({ claimLimit: 4, concurrencyLimit: 2 }),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.deepEqual(startedJobs.sort(), [
      "job-1",
      "job-2",
      "job-3",
      "job-4",
    ]);
    assert.deepEqual(result.sessionIds.sort(), [
      "session-job-1",
      "session-job-2",
      "session-job-3",
      "session-job-4",
    ]);
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
        async hasRecordedOutcome(jobId) {
          completed.push(jobId);
          return true;
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
          settlement: "completed",
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

  it("logs retry, route, and completion progress", async () => {
    const job = claimedJob("job-1", "repository-1");
    const logs: CapturedLog[] = [];
    let claimAttempt = 0;
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 1, jobIds: [job.id] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue() {
          claimAttempt += 1;
          if (claimAttempt === 1) {
            throw new Error("Temporary database timeout.");
          }
          return [job];
        },
        async hasRecordedOutcome() {
          return true;
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
        start: async () => ({
          sessionId: "session-1",
          settlement: "completed",
        }),
      },
      config: dispatcherConfig(),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
      logger: captureLogger(logs),
    });

    await dispatcher.dispatch();

    assert.equal(
      logs.some(
        (log) =>
          log.level === "warn" &&
          log.message === "review job claim attempt failed" &&
          log.attributes.attempt === 1,
      ),
      true,
    );
    assert.equal(
      logs.some(
        (log) =>
          log.message === "review dispatch routes loaded" &&
          Array.isArray(log.attributes.missingRouteJobIds) &&
          log.attributes.missingRouteJobIds.length === 0,
      ),
      true,
    );
    assert.equal(
      logs.some(
        (log) =>
          log.message === "review dispatch completed" &&
          log.attributes.completedCount === 1 &&
          log.attributes.failedCount === 0 &&
          typeof log.attributes.durationMs === "number",
      ),
      true,
    );
  });

  it("requeues a settled session that omitted its terminal outcome", async () => {
    const job = claimedJob("job-1", "repository-1");
    const failures: Array<{ code: string; message: string }> = [];
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 1, jobIds: [job.id] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue() {
          return [job];
        },
        async hasRecordedOutcome() {
          return false;
        },
        async fail(input) {
          failures.push({ code: input.code, message: input.message });
          return {};
        },
      },
      routes: {
        loadDispatchRoutes: async () => [
          { reviewJobId: job.id, slackChannelId: "C0123456789" },
        ],
      },
      receiver: {
        start: async () => ({
          sessionId: "session-1",
          settlement: "completed",
        }),
      },
      config: dispatcherConfig(),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.equal(result.completedCount, 0);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(failures, [
      {
        code: "REVIEW_SESSION_FAILED",
        message:
          "The review session settled without recording a terminal outcome.",
      },
    ]);
  });

  it("keeps an approval-waiting session leased without failing the job", async () => {
    const job = claimedJob("job-1", "repository-1");
    const failures: string[] = [];
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: {
        enqueue: async () => ({ candidateCount: 1, jobIds: [job.id] }),
      },
      queue: {
        async recoverExpiredLeases() {
          return [];
        },
        async claimDue() {
          return [job];
        },
        async hasRecordedOutcome() {
          return false;
        },
        async fail(input) {
          failures.push(input.jobId);
          return {};
        },
      },
      routes: {
        loadDispatchRoutes: async () => [
          { reviewJobId: job.id, slackChannelId: "C0123456789" },
        ],
      },
      receiver: {
        start: async () => ({
          sessionId: "session-1",
          settlement: "waiting",
        }),
      },
      config: dispatcherConfig(),
      createId: idSequence("claim-id", "worker-id"),
      clock: () => NOW,
    });

    const result = await dispatcher.dispatch();

    assert.equal(result.completedCount, 0);
    assert.equal(result.waitingCount, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.sessionIds, ["session-1"]);
    assert.deepEqual(failures, []);
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

interface CapturedLog {
  level: LogLevel;
  message: string;
  attributes: LogAttributes;
}

function captureLogger(logs: CapturedLog[]): Logger {
  return {
    debug(message, attributes = {}) {
      logs.push({ level: "debug", message, attributes });
    },
    info(message, attributes = {}) {
      logs.push({ level: "info", message, attributes });
    },
    warn(message, attributes = {}) {
      logs.push({ level: "warn", message, attributes });
    },
    error(message, attributes = {}) {
      logs.push({ level: "error", message, attributes });
    },
  };
}
