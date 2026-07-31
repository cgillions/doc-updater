import { defineTool } from "eve/tools";

import { AssignedRepositoryReader } from "../lib/application/repositories/read-assigned-repository.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import {
  repositoryFileReadResultSchema,
  repositoryFileRequestSchema,
} from "../lib/domain/repositories/repository-review.ts";
import { createGitHubRepositoryReviewClient } from "../lib/github/repository-review-client-factory.ts";
import { GitHubRepositoryReviewRequestError } from "../lib/github/repository-review-client.ts";

export default defineTool({
  description:
    "Read one UTF-8 file at the assigned repository's exact base or head " +
    "revision. If a safe path is absent at that revision, returns a typed " +
    "not-found result instead of failing the tool call. Repository identity " +
    "and revision SHAs cannot be supplied by the model.",
  inputSchema: repositoryFileRequestSchema,
  outputSchema: repositoryFileReadResultSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      const reader = new AssignedRepositoryReader(
        new ReviewJobContextStore(database),
        createGitHubRepositoryReviewClient(),
      );
      try {
        return await reader.readFile(context.session.auth, input);
      } catch (error) {
        if (
          error instanceof GitHubRepositoryReviewRequestError &&
          error.status === 404
        ) {
          return {
            status: "not-found" as const,
            path: input.path,
            revision: input.revision,
            guidance:
              "This path does not exist at the assigned revision. Use " +
              "load_repository_review_scope or search_repository to discover " +
              "an exact returned path, then retry read_repository_file. If the " +
              "required evidence cannot be found, complete the review as " +
              "incomplete.",
          };
        }
        throw error;
      }
    } finally {
      await database.$disconnect();
    }
  },
});
