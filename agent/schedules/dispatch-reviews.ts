import { defineSchedule } from "eve/schedules";

import { runScheduledReviewDispatch } from "../lib/eve/scheduled-review-dispatch.ts";

export default defineSchedule({
  cron: "0 8 * * 1-5",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(runScheduledReviewDispatch({ receive, appAuth }));
  },
});
