import { defineTool } from "eve/tools";
import { z } from "zod";

import { AssignedRepositoryReader } from "../lib/application/repositories/read-assigned-repository.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import { repositoryReviewScopeSchema } from "../lib/domain/repositories/repository-review.ts";
import { createGitHubRepositoryReviewClient } from "../lib/github/repository-review-client-factory.ts";

export default defineTool({
  description:
    "Load the complete bounded comparison for the assigned job, including " +
    "ordered commits, available file patches, changed implementation paths, " +
    "and candidate repository documentation. Repository identity and " +
    "revisions come from trusted session authentication.",
  inputSchema: z.object({}),
  outputSchema: repositoryReviewScopeSchema,
  async execute(_input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedRepositoryReader(
        new ReviewJobContextStore(database),
        createGitHubRepositoryReviewClient(),
      ).loadScope(context.session.auth);
    } finally {
      await database.$disconnect();
    }
  },
});
