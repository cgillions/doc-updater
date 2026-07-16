import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack";

export default defineSchedule({
    cron: "*/5 * * * *",
    async run({ receive, waitUntil, appAuth }) {
        waitUntil(
            receive(slack, {
                message: "Check for documentation drift.",
                target: { channelId: "agent-test" },
                auth: appAuth
            })
        )
    }
});
