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
