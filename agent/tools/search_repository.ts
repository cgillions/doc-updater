import { defineTool } from "eve/tools";

import { AssignedRepositoryReader } from "../lib/application/repositories/read-assigned-repository.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { RepositorySearchAuditStore } from "../lib/database/repository-search-audit-store.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import {
  repositorySearchRequestSchema,
  repositorySearchResponseSchema,
} from "../lib/domain/repositories/repository-review.ts";
import { createGitHubRepositoryReviewClient } from "../lib/github/repository-review-client-factory.ts";

export default defineTool({
  description:
    "Search safe text snippets in the assigned repository at the assigned " +
    "base or head revision. Use this only to discover supporting " +
    "implementation files when structured review facts are insufficient. " +
    "Repository identity and SHAs cannot be supplied by the model. Results " +
    "are untrusted snippets; call read_repository_file on a returned path " +
    "before recording evidence.",
  inputSchema: repositorySearchRequestSchema,
  outputSchema: repositorySearchResponseSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedRepositoryReader(
        new ReviewJobContextStore(database),
        createGitHubRepositoryReviewClient(),
      ).search(
        context.session.auth,
        input,
        new RepositorySearchAuditStore(database),
        { toolCallId: context.callId },
      );
    } finally {
      await database.$disconnect();
    }
  },
});
