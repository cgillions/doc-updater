import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import publishConfluencePageUpdate from "../../tools/publish_confluence_page_update.ts";
import { confluencePageUpdateResultSchema } from "../domain/reviews/review-records.ts";

test("publish_confluence_page_update exposes history URL after publication", () => {
  const output = confluencePageUpdateResultSchema.parse({
    proposalDigest: "a".repeat(64),
    pageId: "622593",
    publishedVersion: 5,
    pageUrl:
      "https://craftd-art.atlassian.net/wiki/spaces/DU/pages/622593/Doc+Updater",
    historyUrl:
      "https://craftd-art.atlassian.net/wiki/spaces/DU/history/622593/Doc+Updater",
    status: "published",
  });
  const toModelOutput = publishConfluencePageUpdate.toModelOutput;

  assert.ok(publishConfluencePageUpdate.outputSchema);
  assert.ok(toModelOutput);
  assert.deepEqual(toModelOutput(output), {
    type: "json",
    value: {
      pageId: "622593",
      publishedVersion: 5,
      pageUrl:
        "https://craftd-art.atlassian.net/wiki/spaces/DU/pages/622593/Doc+Updater",
      historyUrl:
        "https://craftd-art.atlassian.net/wiki/spaces/DU/history/622593/Doc+Updater",
      status: "published",
    },
  });
});

test("publish_confluence_page_update hides blocked proposal identifiers", () => {
  const output = confluencePageUpdateResultSchema.parse({
    proposalDigest: "a".repeat(64),
    pageId: "622593",
    status: "blocked-existing-draft",
  });

  assert.deepEqual(publishConfluencePageUpdate.toModelOutput?.(output), {
    type: "json",
    value: { status: "blocked-existing-draft" },
  });
});

test("the workflow requests publication and reports the returned history URL", async () => {
  const instructions = await readFile(
    new URL("../../instructions.md", import.meta.url),
    "utf8",
  );
  const slackSkill = await readFile(
    new URL("../../skills/slack-communication/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(instructions, /request\s+`publish_confluence_page_update`/);
  assert.doesNotMatch(instructions, /request `create_confluence_draft`/);
  assert.match(slackSkill, /<historyUrl\|Open version history to review the diff>/);
  assert.match(slackSkill, /approval 💬/);
  assert.doesNotMatch(slackSkill, /:speech_bubble:/);
});
