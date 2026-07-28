import {
  createGitHubAppAccessTokenProvider,
} from "./control-plane-client.ts";
import { GitHubRepositoryReviewClient } from "./repository-review-client.ts";

const GITHUB_CONNECTOR_ID = "github/docia-gh";

/**
 * Creates the production read-only repository evidence client.
 *
 * Authentication uses the existing app-scoped Vercel Connect connector.
 */
export function createGitHubRepositoryReviewClient(): GitHubRepositoryReviewClient {
  return new GitHubRepositoryReviewClient({
    getAccessToken: createGitHubAppAccessTokenProvider(GITHUB_CONNECTOR_ID),
  });
}

