import { defineTool } from "eve/tools";

import { AssignedConfluencePageReviewer } from "../lib/application/documentation/review-confluence-pages.ts";
import { createConfluencePageClient } from "../lib/confluence/page-client-factory.ts";
import { ConfluencePageStore } from "../lib/database/confluence-page-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import {
  confluenceDocumentCandidateSchema,
  getDocumentCandidateInputSchema,
} from "../lib/domain/documentation/confluence-page.ts";

export default defineTool({
  description:
    "Fetch one opaque Confluence candidate from the assigned review scope. " +
    "Returns its immutable version, body hash, and bounded native storage body.",
  inputSchema: getDocumentCandidateInputSchema,
  outputSchema: confluenceDocumentCandidateSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedConfluencePageReviewer(
        new ReviewJobContextStore(database),
        new ConfluencePageStore(database),
        createConfluencePageClient(),
      ).get(context.session.auth, input.candidateId);
    } finally {
      await database.$disconnect();
    }
  },
});
