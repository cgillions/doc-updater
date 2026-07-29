import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { confluenceDraftCreationResultSchema } from "../domain/reviews/review-records.ts";
import createConfluenceDraft from "../../tools/create_confluence_draft.ts";

test("create_confluence_draft exposes a blocked result without opaque identifiers", () => {
  const output = confluenceDraftCreationResultSchema.parse({
    proposalDigest: "a".repeat(64),
    pageId: "12345",
    status: "blocked-existing-draft",
  });
  const toModelOutput = createConfluenceDraft.toModelOutput;

  assert.ok(createConfluenceDraft.outputSchema);
  assert.ok(toModelOutput);
  assert.deepEqual(toModelOutput(output), {
    type: "json",
    value: { status: "blocked-existing-draft" },
  });
});

test("blocked Confluence drafts require a detailed Slack-thread report", async () => {
  const instructions = await readFile(
    new URL("../../instructions.md", import.meta.url),
    "utf8",
  );

  assert.match(instructions, /Confluence reported that the page already has a draft/);
  assert.match(
    instructions,
    /stored artifact\s+history does not decide this outcome/,
  );
  assert.match(instructions, /Status: The page needs the proposed update/);
  assert.match(instructions, /What I checked:/);
  assert.match(instructions, /Next step:/);
  assert.match(instructions, /No new draft was\s+created so existing work is preserved/);
});
