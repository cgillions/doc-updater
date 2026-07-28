import { defineTool } from "eve/tools";

import { AssignedRepositoryReader } from "../lib/application/repositories/read-assigned-repository.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import { ReviewJobContextStore } from "../lib/database/review-job-context-store.ts";
import {
  repositoryFileContentSchema,
  repositoryFileRequestSchema,
} from "../lib/domain/repositories/repository-review.ts";
import { createGitHubRepositoryReviewClient } from "../lib/github/repository-review-client-factory.ts";

export default defineTool({
  description:
    "Read one UTF-8 file at the assigned repository's exact base or head " +
    "revision. Repository identity and revision SHAs cannot be supplied by " +
    "the model.",
  inputSchema: repositoryFileRequestSchema,
  outputSchema: repositoryFileContentSchema,
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await new AssignedRepositoryReader(
        new ReviewJobContextStore(database),
        createGitHubRepositoryReviewClient(),
      ).readFile(context.session.auth, input);
    } finally {
      await database.$disconnect();
    }
  },
});

