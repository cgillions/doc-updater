import { defineTool } from "eve/tools";

import { AssignedConfluenceReviewRecorder } from "../lib/application/documentation/record-confluence-review.ts";
import { ChangeProposalStore } from "../lib/database/change-proposal-store.ts";
import { ConfluencePageStore } from "../lib/database/confluence-page-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { createConfluenceProposalInputSchema } from "../lib/domain/documentation/confluence-page.ts";
import { changeProposalRecordSchema } from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Persist an exact-fragment native-storage proposal for a fetched opaque " +
    "Confluence candidate. This tool cannot create a draft or publish a page.",
  inputSchema: createConfluenceProposalInputSchema,
  outputSchema: changeProposalRecordSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedConfluenceReviewRecorder(
        new ConfluencePageStore(database),
      ).createProposal(
        context.session.auth,
        input,
        new ChangeProposalStore(database),
      );
    } finally {
      await database.$disconnect();
    }
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: {
        id: output.id,
        digest: output.digest,
      },
    };
  },
});
