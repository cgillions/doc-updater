import { getToken } from "@vercel/connect";
import { vercelOidc } from "eve/channels/auth";
import { slackChannel } from "eve/channels/slack";

import { buildInputRequestCard } from "../lib/slack-input-request.ts";

export default slackChannel({
  credentials: {
    botToken: () => getToken("slack/docia", {
      subject: { type: "app" },
    }),
    webhookVerifier: vercelOidc(),
  },
  events: {
    async "input.requested"({ requests }, channel) {
      for (const request of requests) {
        await channel.thread.post({
          card: buildInputRequestCard(request),
        });
      }
    },
  },
});
