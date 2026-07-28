import { defineSchedule } from "eve/schedules";

import { runScheduledReviewDispatch } from "../lib/eve/scheduled-review-dispatch.ts";

export default defineSchedule({
  cron: "0 7 * * 1-5",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(runScheduledReviewDispatch({ receive, appAuth }));
  },
});
