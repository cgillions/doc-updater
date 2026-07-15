import { getToken } from "@vercel/connect";
import { vercelOidc } from "eve/channels/auth";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: {
    botToken: () => getToken("slack/docia", {
      subject: { type: "app" },
    }),
    webhookVerifier: vercelOidc(),
  },
});
