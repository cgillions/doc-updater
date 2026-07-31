import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleCompletedSlackMessage,
  handleSlackActionsRequested,
} from "../../channels/slack.ts";
import type { SlackApprovalDetailsReader } from "./slack-approval-details.ts";

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

describe("handleSlackActionsRequested", () => {
  it("posts trusted approval details while preserving Eve's action status", async () => {
    const posts: string[] = [];
    const typingStatuses: Array<string | undefined> = [];
    const channel = {
      state: {
        channelId: null,
        threadTs: null,
        teamId: null,
        pendingToolCallMessage: "Preparing the documentation pull request.",
      },
      thread: {
        async post(message: unknown) {
          posts.push(String(message));
        },
        async startTyping(status?: string) {
          typingStatuses.push(status);
        },
      },
    } as unknown as Parameters<typeof handleSlackActionsRequested>[1];
    const context = {
      session: {
        id: "session-1",
        auth: {
          current: null,
          initiator: {
            authenticator: "app",
            principalId: "eve:app",
            principalType: "runtime",
            attributes: {
              reviewJobId: "11111111-1111-4111-8111-111111111111",
            },
          },
        },
        turn: { id: "turn-1", sequence: 0 },
      },
    } as unknown as Parameters<typeof handleSlackActionsRequested>[2];
    const event = {
      actions: [
        {
          callId: "call-1",
          input: { proposalDigest: "a".repeat(64) },
          kind: "tool-call",
          toolName: "create_repository_pull_request",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
    } as unknown as Parameters<typeof handleSlackActionsRequested>[0];

    await handleSlackActionsRequested(
      event,
      channel,
      context,
      repositoryApprovalReader(),
    );

    assert.deepEqual(typingStatuses, [
      "Preparing the documentation pull request.",
    ]);
    assert.equal(posts.length, 1);
    assert.match(posts[0] ?? "", /example\/service/);
    assert.match(posts[0] ?? "", /docs\/orders\.md/);
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

function repositoryApprovalReader(): SlackApprovalDetailsReader {
  return {
    async loadRepositoryProposal() {
      return {
        id: "33333333-3333-4333-8333-333333333333",
        reviewJobId: "11111111-1111-4111-8111-111111111111",
        repositoryId: "22222222-2222-4222-8222-222222222222",
        repositoryFullName: "example/service",
        defaultBranch: "main",
        digest: "a".repeat(64),
        baseSha: "b".repeat(40),
        path: "docs/orders.md",
        content: "# Orders\n",
      };
    },
    async loadConfluenceProposal() {
      return null;
    },
  };
}
