import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

/** Production Slack edge using the existing Vercel Connect client. */
export default slackChannel({
  credentials: connectSlackCredentials("slack/docia"),
});
