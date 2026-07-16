import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const instructionsPath = new URL("../instructions.md", import.meta.url);

test("requires an exhaustive commit inventory for the exact review window", async () => {
  const instructions = await readFile(instructionsPath, "utf8");

  assert.match(instructions, /Call `get_review_window` once/);
  assert.match(instructions, /Treat `list_commits` as the authoritative activity inventory/);
  assert.match(instructions, /`perPage: 100`/);
  assert.match(instructions, /Continue with page 2, 3, and so on/);
  assert.match(instructions, /Do not stop after merged pull requests/);
});

test("documents the exact GitHub MCP pull-request diff input", async () => {
  const instructions = await readFile(instructionsPath, "utf8");

  assert.match(instructions, /`method: "get_diff"`/);
  assert.match(instructions, /`pullNumber`/);
  assert.doesNotMatch(instructions, /`method: "diff"`/);
});

test("requires one concise outcome-only Slack report", async () => {
  const instructions = await readFile(instructionsPath, "utf8");

  assert.match(instructions, /Send exactly one final Slack message/);
  assert.match(instructions, /\*Documentation drift report\*/);
  assert.match(instructions, /one bullet per\s+configured repository/);
  assert.match(instructions, /Do not summarize commits, pull requests, changed files, or investigation steps/);
  assert.match(instructions, /Do not wrap the report in a code block/);
  assert.match(instructions, /Do not offer a deeper\s+pass or ask a follow-up question/);
  assert.match(instructions, /Documentation drift fixed in \[PR #1234\]\(https:\/\/github\.com\/owner\/repo\/pull\/1234\)\./);
});
