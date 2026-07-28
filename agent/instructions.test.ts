import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const instructionsPath = new URL("./instructions.md", import.meta.url);

test("review instructions require directional, final-head evidence", async () => {
  const instructions = await readFile(instructionsPath, "utf8");

  assert.match(instructions, /ordered commits/i);
  assert.match(instructions, /base and head excerpts/i);
  assert.match(instructions, /change direction/i);
  assert.match(instructions, /final-head documentation/i);
  assert.match(instructions, /each material behavior independently/i);
  assert.match(instructions, /record_github_drift_evidence/);
  assert.doesNotMatch(instructions, /`record_drift_evidence`/);
});
