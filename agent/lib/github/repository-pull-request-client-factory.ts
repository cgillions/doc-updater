import {
  createGitHubAppAccessTokenProvider,
} from "./control-plane-client.ts";
import { GitHubRepositoryPullRequestClient } from "./repository-pull-request-client.ts";

const GITHUB_CONNECTOR_ID = "github/docia-gh";

/**
 * Creates the application-owned GitHub pull-request writer.
 *
 * The existing connector's token is obtained only inside the approved creator
 * tool. The read-only review client exposes no mutation operations.
 */
export function createGitHubRepositoryPullRequestClient(): GitHubRepositoryPullRequestClient {
  return new GitHubRepositoryPullRequestClient({
    getAccessToken: createGitHubAppAccessTokenProvider(
      GITHUB_CONNECTOR_ID,
    ),
  });
}
