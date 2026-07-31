import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConfluencePageUpdateDetails,
  formatRepositoryPullRequestDetails,
  loadSlackApprovalDetails,
  type SlackApprovalDetailsReader,
} from "./slack-approval-details.ts";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_DIGEST = "a".repeat(64);
const CONFLUENCE_DIGEST = "b".repeat(64);

test("loads trusted repository details without exposing the proposal digest", async () => {
  const messages = await loadSlackApprovalDetails(
    [
      {
        kind: "tool-call",
        toolName: "create_repository_pull_request",
        input: { proposalDigest: REPOSITORY_DIGEST },
      },
    ],
    REVIEW_JOB_ID,
    reader(),
  );

  assert.deepEqual(messages, [
    [
      "*Approval details — create repository pull request*",
      "• Repository: `example/service`",
      "• File: `docs/orders.md`",
      "• Base branch: `main`",
      "• Change: apply the reviewed documentation replacement (4 lines).",
      "• Effect: creates one pull request only; it does not merge or publish the change.",
    ].join("\n"),
  ]);
  assert.doesNotMatch(messages[0] ?? "", new RegExp(REPOSITORY_DIGEST));
});

test("formats Confluence details around the exact page safety boundary", () => {
  const message = formatConfluencePageUpdateDetails({
    id: "33333333-3333-4333-8333-333333333333",
    repositoryId: "22222222-2222-4222-8222-222222222222",
    reviewJobId: REVIEW_JOB_ID,
    digest: CONFLUENCE_DIGEST,
    implementationSha: "c".repeat(40),
    pageTitle: "Doc Updater",
    pageUrl:
      "https://craftd-art.atlassian.net/wiki/spaces/DU/pages/622593/Doc+Updater",
    target: {
      siteId: "craftd-art.atlassian.net",
      pageId: "622593",
      version: 4,
      bodyHash: "d".repeat(64),
    },
    patch: {
      baselineStorageValue: "<p>Old</p>",
      baselineFragmentHash: "e".repeat(64),
      replacementStorageValue: "<p>New</p>",
    },
  });

  assert.match(
    message,
    /<https:\/\/craftd-art\.atlassian\.net\/wiki\/spaces\/DU\/pages\/622593\/Doc\+Updater\|Doc Updater>/,
  );
  assert.match(message, /Current version: 4/);
  assert.match(message, /one exact content fragment/);
  assert.match(message, /preserves unrelated content/);
  assert.match(message, /unpublished draft exists/);
  assert.doesNotMatch(message, new RegExp(CONFLUENCE_DIGEST));
});

test("ignores unrelated actions and invalid approval inputs", async () => {
  const messages = await loadSlackApprovalDetails(
    [
      { kind: "tool-call", toolName: "load_review_job", input: {} },
      {
        kind: "tool-call",
        toolName: "create_repository_pull_request",
        input: { proposalDigest: "not-a-digest" },
      },
    ],
    REVIEW_JOB_ID,
    reader(),
  );

  assert.deepEqual(messages, []);
});

function reader(): SlackApprovalDetailsReader {
  return {
    async loadRepositoryProposal(_reviewJobId, proposalDigest) {
      return proposalDigest === REPOSITORY_DIGEST
        ? {
            id: "33333333-3333-4333-8333-333333333333",
            reviewJobId: REVIEW_JOB_ID,
            repositoryId: "22222222-2222-4222-8222-222222222222",
            repositoryFullName: "example/service",
            defaultBranch: "main",
            digest: REPOSITORY_DIGEST,
            baseSha: "f".repeat(40),
            path: "docs/orders.md",
            content: "# Orders\n\nUse an idempotency key.\n",
          }
        : null;
    },
    async loadConfluenceProposal() {
      return null;
    },
  };
}
