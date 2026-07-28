import { defineTool } from "eve/tools";
import {always, once} from "eve/tools/approval";

import { createAssignedRepositoryPullRequest } from "../lib/application/repositories/create-repository-pull-request.ts";
import { RepositoryPullRequestStore } from "../lib/database/repository-pull-request-store.ts";
import { createDatabaseClient } from "../lib/database/client.ts";
import {
  createRepositoryPullRequestInputSchema,
  repositoryPullRequestRecordSchema,
} from "../lib/domain/reviews/review-records.ts";
import { createGitHubRepositoryPullRequestClient } from "../lib/github/repository-pull-request-client-factory.ts";

export default defineTool({
  description:
    "Create one approval-gated pull request from an immutable stored repository " +
    "proposal. The proposal digest must have been returned by " +
    "create_github_change_proposal for this assigned review job. Repository, " +
    "branch, path, and content are loaded from trusted storage.",
  inputSchema: createRepositoryPullRequestInputSchema,
  outputSchema: repositoryPullRequestRecordSchema,
  approval: once(),
  async execute(input, context) {
    const database = createDatabaseClient();
    try {
      return await createAssignedRepositoryPullRequest(
        context.session.auth,
        input,
        {
          store: new RepositoryPullRequestStore(database),
          github: createGitHubRepositoryPullRequestClient(),
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
    return {
      type: "json",
      value: {
        proposalDigest: output.proposalDigest,
        pullRequestNumber: output.pullRequestNumber,
        pullRequestUrl: output.pullRequestUrl,
      },
    };
  },
});
