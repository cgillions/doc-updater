import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const connectionPath = new URL("../connections/github.ts", import.meta.url);

test("exposes the complete branch, file-write, and pull-request workflow", async () => {
  const connection = await readFile(connectionPath, "utf8");

  assert.match(connection, /"create_branch"/);
  assert.match(connection, /"push_files"/);
  assert.match(connection, /"create_pull_request"/);
});

test("keeps pull-request publication behind user approval", async () => {
  const connection = await readFile(connectionPath, "utf8");

  assert.match(
    connection,
    /toolsRequiringApproval = \[[^\]]*"github__create_pull_request"[^\]]*\]/s,
  );
});
