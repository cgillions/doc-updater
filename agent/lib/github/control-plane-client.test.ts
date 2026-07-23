import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitHubControlPlaneClient,
  GitHubControlPlaneRequestError,
} from "./control-plane-client.ts";

const FIRST_SHA = "a".repeat(40);
const SECOND_SHA = "b".repeat(40);
const THIRD_SHA = "c".repeat(40);

describe("GitHubControlPlaneClient", () => {
  it("paginates the complete installation inventory and resolves branch heads", async () => {
    const requests: string[] = [];
    const client = new GitHubControlPlaneClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/installation/repositories?per_page=100&page=1",
            jsonResponse({
              total_count: 3,
              repositories: [
                repositoryFixture(101, "example/alpha", "main"),
                repositoryFixture(102, "example/beta", "trunk", true),
              ],
            }),
          ],
          [
            "/installation/repositories?per_page=100&page=2",
            jsonResponse({
              total_count: 3,
              repositories: [
                repositoryFixture(103, "example/gamma", "release/current"),
              ],
            }),
          ],
          [
            "/repos/example/alpha/git/ref/heads/main",
            jsonResponse(referenceFixture(FIRST_SHA)),
          ],
          [
            "/repos/example/beta/git/ref/heads/trunk",
            jsonResponse(referenceFixture(SECOND_SHA)),
          ],
          [
            "/repos/example/gamma/git/ref/heads/release%2Fcurrent",
            jsonResponse(referenceFixture(THIRD_SHA)),
          ],
        ]),
        requests,
      ),
    });

    const repositories = await client.listInstallationRepositories();

    assert.deepEqual(repositories, [
      {
        githubRepositoryId: "101",
        repositoryFullName: "example/alpha",
        defaultBranch: "main",
        defaultBranchHeadSha: FIRST_SHA,
        isArchived: false,
      },
      {
        githubRepositoryId: "102",
        repositoryFullName: "example/beta",
        defaultBranch: "trunk",
        defaultBranchHeadSha: SECOND_SHA,
        isArchived: true,
      },
      {
        githubRepositoryId: "103",
        repositoryFullName: "example/gamma",
        defaultBranch: "release/current",
        defaultBranchHeadSha: THIRD_SHA,
        isArchived: false,
      },
    ]);
    assert.deepEqual(requests.slice(0, 2), [
      "/installation/repositories?per_page=100&page=1",
      "/installation/repositories?per_page=100&page=2",
    ]);
  });

  it("fails instead of returning a partial inventory when a page is missing", async () => {
    const client = new GitHubControlPlaneClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/installation/repositories?per_page=100&page=1",
            jsonResponse({
              total_count: 2,
              repositories: [repositoryFixture(201, "example/alpha", "main")],
            }),
          ],
          [
            "/installation/repositories?per_page=100&page=2",
            jsonResponse({ total_count: 2, repositories: [] }),
          ],
        ]),
      ),
    });

    await assert.rejects(
      client.listInstallationRepositories(),
      /ended after 1 of 2 repositories/,
    );
  });

  it("fails the complete inventory when a branch head cannot be read", async () => {
    const client = new GitHubControlPlaneClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/installation/repositories?per_page=100&page=1",
            jsonResponse({
              total_count: 2,
              repositories: [
                repositoryFixture(301, "example/alpha", "main"),
                repositoryFixture(302, "example/beta", "main"),
              ],
            }),
          ],
          [
            "/repos/example/alpha/git/ref/heads/main",
            jsonResponse(referenceFixture(FIRST_SHA)),
          ],
          [
            "/repos/example/beta/git/ref/heads/main",
            jsonResponse({ message: "Service unavailable" }, 503),
          ],
        ]),
      ),
    });

    await assert.rejects(
      client.listInstallationRepositories(),
      (error: unknown) =>
        error instanceof GitHubControlPlaneRequestError &&
        error.status === 503 &&
        error.requestPath === "/repos/example/beta/git/ref/heads/main",
    );
  });
});

function repositoryFixture(
  id: number,
  fullName: string,
  defaultBranch: string,
  archived = false,
): object {
  return {
    id,
    full_name: fullName,
    default_branch: defaultBranch,
    archived,
  };
}

function referenceFixture(sha: string): object {
  return {
    ref: "refs/heads/main",
    object: {
      type: "commit",
      sha,
    },
  };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFixtureFetch(
  fixtures: Map<string, Response>,
  requests: string[] = [],
): typeof fetch {
  return async (input) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const requestPath = `${url.pathname}${url.search}`;
    requests.push(requestPath);
    const response = fixtures.get(requestPath);
    if (!response) {
      return jsonResponse({ message: `No fixture for ${requestPath}` }, 404);
    }
    return response.clone();
  };
}
