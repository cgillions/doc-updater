import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack";

export default defineSchedule({
    cron: "*/5 * * * *",
    async run({ receive, waitUntil, appAuth }) {
        waitUntil(
            receive(slack, {
                message: "Complete your workflow precisely.",
                target: { channelId: "agent-test" },
                auth: appAuth
            })
        )
    }
});
