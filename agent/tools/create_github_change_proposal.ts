import { defineTool } from "eve/tools";

import { createAssignedChangeProposal } from "../lib/application/reviews/assigned-review-records.ts";
import { ChangeProposalStore } from "../lib/database/change-proposal-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import {
  changeProposalRecordSchema,
  repositoryChangeProposalInputSchema,
} from "../lib/domain/reviews/review-records.ts";

export default defineTool({
  description:
    "Persist one immutable, evidence-backed Github repository-file proposal. The " +
    "target must belong to the assigned review job. This tool does not create " +
    "a pull request or other external artifact.",
  inputSchema: repositoryChangeProposalInputSchema,
  outputSchema: changeProposalRecordSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await createAssignedChangeProposal(
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
        repositoryBaselineSha: output.repositoryBaselineSha,
      },
    };
  },
});
