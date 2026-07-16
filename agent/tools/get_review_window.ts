import { defineTool } from "eve/tools";
import { z } from "zod";

import { createReviewWindow } from "../lib/review-window.ts";

export default defineTool({
  description: "Get the exact UTC start and end timestamps for this run's 24-hour GitHub review window.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    mergedSearchDate: z.iso.date(),
  }),
  execute() {
    return createReviewWindow(new Date());
  },
});
