import { defineTool } from "eve/tools";

import { recordAssignedDriftEvidence } from "../lib/application/reviews/assigned-review-records.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { EvidenceClaimStore } from "../lib/database/evidence-claim-store.ts";
import {
  evidenceClaimRecordSchema,
  recordRepositoryEvidenceInputSchema,
} from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Persist one factual documentation-drift claim with explicit base/head " +
    "behavior comparisons, final-head documentation classifications, and " +
    "implementation references for one GitHub repository documentation file. " +
    "Repository identity and implementation SHA come from the assigned job.",
  inputSchema: recordRepositoryEvidenceInputSchema,
  outputSchema: evidenceClaimRecordSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await recordAssignedDriftEvidence(
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
