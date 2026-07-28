import { defineTool } from "eve/tools";

import { completeAssignedReviewJob } from "../lib/application/reviews/assigned-review-records.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewCompletionStore } from "../lib/database/review-completion-store.ts";
import {
  completedReviewJobSchema,
  completeReviewJobInputSchema,
} from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Record the terminal outcome of the assigned review job. Successful " +
    "outcomes advance its repository cursor; incomplete outcomes preserve " +
    "the existing cursor. Successful outcomes require persisted implementation " +
    "evidence.",
  inputSchema: completeReviewJobInputSchema,
  outputSchema: completedReviewJobSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await completeAssignedReviewJob(
        context.session.auth,
        input,
        new ReviewCompletionStore(database),
      );
    } finally {
      await database.$disconnect();
    }
  },
});
