import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requireSlackChannelId } from "./slack-channel-id.ts";

const schedulePath = new URL("../schedules/update-docs.ts", import.meta.url);

test("accepts canonical Slack channel IDs", () => {
  assert.equal(requireSlackChannelId("C0123ABCDEF"), "C0123ABCDEF");
  assert.equal(requireSlackChannelId("G0123ABCDEF"), "G0123ABCDEF");
});

test("rejects channel names that cannot resume Slack interactions", () => {
  assert.throws(
    () => requireSlackChannelId("agent-test"),
    /SLACK_CHANNEL_ID must be a canonical Slack channel ID/,
  );
  assert.throws(
    () => requireSlackChannelId(undefined),
    /SLACK_CHANNEL_ID must be a canonical Slack channel ID/,
  );
});

test("the scheduled run resolves its target from SLACK_CHANNEL_ID", async () => {
  const schedule = await readFile(schedulePath, "utf8");

  assert.match(schedule, /channelId: requireSlackChannelId\(\)/);
  assert.doesNotMatch(schedule, /channelId: "agent-test"/);
});
