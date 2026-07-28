import { defineTool } from "eve/tools";
import { z } from "zod";

import { AssignedReviewJobLoader } from "../lib/application/review-jobs/load-assigned-review-job.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import { reviewJobContextSchema } from "../lib/domain/review-jobs/review-job-context.ts";

export default defineTool({
  description:
    "Load the immutable repository and documentation scope assigned to this " +
    "scheduled review session. The assigned job comes from trusted session " +
    "authentication and cannot be selected in tool input.",
  inputSchema: z.object({}),
  outputSchema: reviewJobContextSchema,
  async execute(_input, ctx) {
    const database = createDatabaseClient();
    try {
      return await new AssignedReviewJobLoader(
        new ReviewJobContextStore(database),
      ).load(ctx.session.auth);
    } finally {
      await database.$disconnect();
    }
  },
});
