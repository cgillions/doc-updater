import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ScheduleHandlerArgs } from "eve/schedules";

import { createSlackReviewSessionReceiver } from "./review-session-receiver.ts";

const APP_AUTH: ScheduleHandlerArgs["appAuth"] = {
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
  attributes: {},
};

describe("createSlackReviewSessionReceiver", () => {
  it("binds only the opaque job ID and waits for the initial turn to settle", async () => {
    const requests: unknown[] = [];
    let sessionSequence = 0;
    const receive = (async (_channel, options) => {
      requests.push(options);
      sessionSequence += 1;
      return sessionHandle(`session-${sessionSequence}`, [
        { type: "session.started" },
        { type: "turn.completed" },
        { type: "session.waiting" },
      ]);
    }) as ScheduleHandlerArgs["receive"];
    const receiver = createSlackReviewSessionReceiver(receive, APP_AUTH);

    const sessions = await Promise.all([
      receiver.start({
        reviewJobId: "11111111-1111-4111-8111-111111111111",
        slackChannelId: "C0123456789",
      }),
      receiver.start({
        reviewJobId: "22222222-2222-4222-8222-222222222222",
        slackChannelId: "C9876543210",
      }),
    ]);

    assert.deepEqual(sessions, [
      { sessionId: "session-1" },
      { sessionId: "session-2" },
    ]);
    assert.deepEqual(requests, [
      {
        message:
          "Load the repository review assigned to this session and report " +
          "its diagnostic status. Do not assess drift or create artifacts.",
        target: { channelId: "C0123456789" },
        auth: {
          authenticator: "app",
          principalId: "eve:app",
          principalType: "runtime",
          attributes: {
            reviewJobId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
      {
        message:
          "Load the repository review assigned to this session and report " +
          "its diagnostic status. Do not assess drift or create artifacts.",
        target: { channelId: "C9876543210" },
        auth: {
          authenticator: "app",
          principalId: "eve:app",
          principalType: "runtime",
          attributes: {
            reviewJobId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    ]);
  });

  it("rejects a failed initial session turn", async () => {
    const receive = (async () =>
      sessionHandle("session-failed", [
        {
          type: "turn.failed",
          data: { code: "model_error", message: "Model request failed." },
        },
      ])) as ScheduleHandlerArgs["receive"];
    const receiver = createSlackReviewSessionReceiver(receive, APP_AUTH);

    await assert.rejects(
      receiver.start({
        reviewJobId: "11111111-1111-4111-8111-111111111111",
        slackChannelId: "C0123456789",
      }),
      /Model request failed/,
    );
  });
});

function sessionHandle(
  id: string,
  events: Array<{ type: string; data?: unknown }>,
) {
  return {
    id,
    continuationToken: `continuation-${id}`,
    async cancel() {
      return { status: "no_active_turn" as const };
    },
    async getEventStream() {
      return new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(event);
          }
          controller.close();
        },
      });
    },
  };
}
