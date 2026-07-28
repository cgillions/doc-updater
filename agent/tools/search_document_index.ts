import { defineTool } from "eve/tools";

import { AssignedConfluencePageReviewer } from "../lib/application/documentation/review-confluence-pages.ts";
import { createConfluencePageClient } from "../lib/confluence/page-client-factory.ts";
import { ConfluencePageStore } from "../lib/database/confluence-page-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import {
  searchDocumentIndexInputSchema,
  searchDocumentIndexResultSchema,
} from "../lib/domain/documentation/confluence-page.ts";

export default defineTool({
  description:
    "Search only exact Confluence pages declared in the assigned Roadie scope. " +
    "Returns opaque candidates; it cannot search or select arbitrary pages.",
  inputSchema: searchDocumentIndexInputSchema,
  outputSchema: searchDocumentIndexResultSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedConfluencePageReviewer(
        new ReviewJobContextStore(database),
        new ConfluencePageStore(database),
        createConfluencePageClient(),
      ).search(context.session.auth, input);
    } finally {
      await database.$disconnect();
    }
  },
});
