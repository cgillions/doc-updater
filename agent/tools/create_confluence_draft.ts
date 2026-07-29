import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

import { createAssignedConfluenceDraft } from "../lib/application/documentation/create-confluence-draft.ts";
import { ConfluenceDraftStore } from "../lib/database/confluence-draft-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import {
  confluenceDraftCreationResultSchema,
  createConfluenceDraftInputSchema,
} from "../lib/domain/reviews/review-records.ts";
import { createConfluenceDraftClient } from "../lib/confluence/draft-client.ts";
import { createConfluencePageClient } from "../lib/confluence/page-client-factory.ts";

export default defineTool({
  description:
    "Create one approval-gated unpublished Confluence draft from an immutable " +
    "stored exact-page proposal. The proposal digest must have been returned " +
    "by create_confluence_change_proposal for this assigned review job. Page " +
    "identity, native content, and the draft body are loaded by trusted code. " +
    "An existing unpublished draft is reported without changing the page.",
  inputSchema: createConfluenceDraftInputSchema,
  outputSchema: confluenceDraftCreationResultSchema,
  approval: always(),
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await createAssignedConfluenceDraft(
        context.session.auth,
        input,
        {
          store: new ConfluenceDraftStore(database),
          pages: createConfluencePageClient(),
          drafts: createConfluenceDraftClient(),
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
      return {
        type: "json",
        value: { status: output.status },
      };
    }
    return {
      type: "json",
      value: {
        proposalDigest: output.proposalDigest,
        pageId: output.pageId,
        draftVersion: output.draftVersion,
        status: output.status,
      },
    };
  },
});
