import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack";
import { requireSlackChannelId } from "../lib/slack-channel-id.ts";

export default defineSchedule({
    cron: "15 9 * * 1-5",
    async run({ receive, waitUntil, appAuth }) {
        waitUntil(
            receive(slack, {
                message: "Complete your workflow precisely.",
                target: { channelId: requireSlackChannelId() },
                auth: appAuth
            })
        )
    }
});
