import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

import { publishAssignedConfluencePageUpdate } from "../lib/application/documentation/publish-confluence-page-update.ts";
import { createConfluencePageUpdateClient } from "../lib/confluence/page-update-client.ts";
import { createConfluencePageClient } from "../lib/confluence/page-client-factory.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ConfluencePageUpdateStore } from "../lib/database/confluence-page-update-store.ts";
import {
  confluencePageUpdateResultSchema,
  publishConfluencePageUpdateInputSchema,
} from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Publish one approval-gated Confluence page update from an immutable " +
    "stored exact-page proposal. Trusted code revalidates the current page " +
    "version and body, preserves unrelated native content, and refuses to " +
    "write when a real unpublished draft exists. Returns the page and version " +
    "history URLs for human diff review.",
  inputSchema: publishConfluencePageUpdateInputSchema,
  outputSchema: confluencePageUpdateResultSchema,
  approval: always(),
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await publishAssignedConfluencePageUpdate(
        context.session.auth,
        input,
        {
          store: new ConfluencePageUpdateStore(database),
          pages: createConfluencePageClient(),
          updater: createConfluencePageUpdateClient(),
          audit: {
            sessionId: context.session.id,
            toolCallId: context.callId,
          },
        },
      );
    } finally {
      await database.$disconnect();
    }
  },
  toModelOutput(output) {
    if (output.status === "blocked-existing-draft") {
      return { type: "json", value: { status: output.status } };
    }
    return {
      type: "json",
      value: {
        pageId: output.pageId,
        publishedVersion: output.publishedVersion,
        pageUrl: output.pageUrl,
        historyUrl: output.historyUrl,
        status: output.status,
      },
    };
  },
});
