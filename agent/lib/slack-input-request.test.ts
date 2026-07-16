import assert from "node:assert/strict";
import test from "node:test";

import type { InputRequest } from "eve/client";
import { cardToBlocks, cardToFallbackText } from "eve/channels/slack";

import { buildInputRequestCard } from "./slack-input-request.ts";

function createPullRequestInputRequest(
  input: InputRequest["action"]["input"],
): InputRequest {
  return {
    action: {
      callId: "call-1",
      input,
      kind: "tool-call",
      toolName: "github__create_pull_request",
    },
    display: "confirmation",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    prompt: "Approve tool call: github__create_pull_request",
    requestId: "request-1",
  };
}

test("renders a clear documentation PR approval card without raw tool input", () => {
  const request = createPullRequestInputRequest({
    base: "main",
    body: [
      "## Documentation Updates - 2026-07-16",
      "",
      "### Changes Made",
      "",
      "- Updated `README.md` with setup guidance",
      "- Aligned `agent/instructions.md` with the review workflow",
      "",
      "### Notes",
      "",
      "None",
    ].join("\n"),
    owner: "cgillions",
    repo: "doc-updater",
    title: "[docs] Update documentation for recent features",
  });

  const blocks = cardToBlocks(buildInputRequestCard(request));
  const fallbackText = cardToFallbackText(buildInputRequestCard(request));
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, /Documentation PR approval/);
  assert.match(
    serialized,
    /I want to open a PR in <https:\/\/github\.com\/cgillions\/doc-updater\|cgillions\/doc-updater>/,
  );
  assert.match(serialized, /Updated `README\.md` with setup guidance/);
  assert.match(serialized, /Aligned `agent\/instructions\.md` with the review workflow/);
  assert.doesNotMatch(serialized, /Approve tool call/);
  assert.doesNotMatch(serialized, /Tool input/);
  assert.doesNotMatch(serialized, /Merged PRs Referenced/);
  assert.match(fallbackText, /Documentation PR approval/);
  assert.match(fallbackText, /cgillions\/doc-updater/);
  assert.doesNotMatch(fallbackText, /Approve tool call/);
});

test("keeps Eve-compatible approve and deny actions", () => {
  const request = createPullRequestInputRequest({
    owner: "cgillions",
    repo: "doc-updater",
    title: "[docs] Update documentation",
  });

  const blocks = cardToBlocks(buildInputRequestCard(request));
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, /eve_input:request-1:button:0/);
  assert.match(serialized, /eve_input:request-1:button:1/);
  assert.match(serialized, /\"value\":\"approve\"/);
  assert.match(serialized, /\"value\":\"deny\"/);
});

test("falls back to the PR title when the body has no changes section", () => {
  const request = createPullRequestInputRequest({
    owner: "cgillions",
    repo: "doc-updater",
    title: "[docs] Patch installation guidance",
  });

  const blocks = cardToBlocks(buildInputRequestCard(request));
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, /apply “\[docs\] Patch installation guidance”/);
});
