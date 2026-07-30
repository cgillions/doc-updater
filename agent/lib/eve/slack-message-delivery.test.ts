import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleCompletedSlackMessage } from "../../channels/slack.ts";

describe("handleCompletedSlackMessage", () => {
  it("posts an approval context that accompanies a tool call", async () => {
    const delivery = slackDelivery();

    await handleCompletedSlackMessage(
      {
        finishReason: "tool-calls",
        message: [
          "<slack_approval_context>",
          "Hey team, I found a docs update that needs approval.",
          "</slack_approval_context>",
        ].join("\n"),
      },
      delivery,
    );

    assert.deepEqual(delivery.posts, [
      "Hey team, I found a docs update that needs approval.",
    ]);
    assert.equal(delivery.state.pendingToolCallMessage, null);
  });

  it("keeps ordinary pre-tool narration as a typing indicator", async () => {
    const delivery = slackDelivery();

    await handleCompletedSlackMessage(
      {
        finishReason: "tool-calls",
        message: "I will load the assigned review job now.\nMore detail.",
      },
      delivery,
    );

    assert.deepEqual(delivery.posts, []);
    assert.equal(
      delivery.state.pendingToolCallMessage,
      "I will load the assigned review job now.",
    );
  });

  it("posts a terminal report normally", async () => {
    const delivery = slackDelivery();

    await handleCompletedSlackMessage(
      {
        finishReason: "stop",
        message: "The review is complete.",
      },
      delivery,
    );

    assert.deepEqual(delivery.posts, ["The review is complete."]);
    assert.equal(delivery.state.pendingToolCallMessage, null);
  });

  it("does not post approval context when the model stops before the tool call", async () => {
    const delivery = slackDelivery();

    await handleCompletedSlackMessage(
      {
        finishReason: "stop",
        message: [
          "<slack_approval_context>",
          "Hey team, I found a docs update that needs approval.",
          "</slack_approval_context>",
        ].join("\n"),
      },
      delivery,
    );

    assert.deepEqual(delivery.posts, []);
    assert.equal(delivery.state.pendingToolCallMessage, null);
  });
});

function slackDelivery() {
  const posts: string[] = [];
  const typingStatuses: Array<string | undefined> = [];

  return {
    posts,
    state: {
      pendingToolCallMessage: null as string | null,
    },
    thread: {
      async post(message: string) {
        posts.push(message);
      },
      async startTyping(status?: string) {
        typingStatuses.push(status);
      },
    },
    typingStatuses,
  };
}
