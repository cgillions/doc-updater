import { defineTool } from "eve/tools";

import { AssignedConfluenceReviewRecorder } from "../lib/application/documentation/record-confluence-review.ts";
import { ConfluencePageStore } from "../lib/database/confluence-page-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { EvidenceClaimStore } from "../lib/database/evidence-claim-store.ts";
import { recordConfluenceEvidenceInputSchema } from "../lib/domain/documentation/confluence-page.ts";
import { evidenceClaimRecordSchema } from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Persist implementation-backed drift evidence for a fetched opaque " +
    "Confluence candidate. Page identity and baseline come from trusted state.",
  inputSchema: recordConfluenceEvidenceInputSchema,
  outputSchema: evidenceClaimRecordSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedConfluenceReviewRecorder(
        new ConfluencePageStore(database),
      ).recordEvidence(
        context.session.auth,
        input,
        new EvidenceClaimStore(database),
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
        implementationSha: output.implementationSha,
      },
    };
  },
});
