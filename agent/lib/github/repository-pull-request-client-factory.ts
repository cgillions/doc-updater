import {
  createGitHubAppAccessTokenProvider,
} from "./control-plane-client.ts";
import { GitHubRepositoryPullRequestClient } from "./repository-pull-request-client.ts";

const GITHUB_PULL_REQUEST_WRITER_CONNECTOR_ID = "github/docia-pr-writer";

/**
 * Creates the dedicated application-owned GitHub pull-request writer.
 *
 * This connector is intentionally separate from the read-only review
 * connector. Its token is obtained only inside the approved creator tool.
 */
export function createGitHubRepositoryPullRequestClient(): GitHubRepositoryPullRequestClient {
  return new GitHubRepositoryPullRequestClient({
    getAccessToken: createGitHubAppAccessTokenProvider(
      GITHUB_PULL_REQUEST_WRITER_CONNECTOR_ID,
    ),
  });
}
