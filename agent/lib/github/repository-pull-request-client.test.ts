import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitHubRepositoryPullRequestClient,
  GitHubRepositoryPullRequestStaleBaseError,
} from "./repository-pull-request-client.ts";

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const FILE_SHA = "c".repeat(40);
const BRANCH = "docs/proposal-123456789abc";
const ENCODED_BRANCH = encodeURIComponent(BRANCH);
const PATH = "docs/orders.md";
const BASE_CONTENT = "# Orders\n\nBefore\n";
const REPLACEMENT_CONTENT = "# Orders\n\nAfter\n";

describe("GitHubRepositoryPullRequestClient", () => {
  it("reuses its deterministic branch and pull request after a lost creation response", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new GitHubRepositoryPullRequestClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/repos/example/service/git/ref/heads/main",
            [jsonResponse(reference(BASE_SHA)), jsonResponse(reference(BASE_SHA))],
          ],
          [
            `/repos/example/service/git/ref/heads/${ENCODED_BRANCH}`,
            [jsonResponse(reference(COMMIT_SHA))],
          ],
          [
            `/repos/example/service/contents/${PATH}?ref=${ENCODED_BRANCH}`,
            [jsonResponse(content(REPLACEMENT_CONTENT, FILE_SHA))],
          ],
          [
            `/repos/example/service/git/commits/${COMMIT_SHA}`,
            [jsonResponse({ parents: [{ sha: BASE_SHA }] })],
          ],
          [
            `/repos/example/service/pulls?state=all&head=example%3Adocs%2Fproposal-123456789abc`,
            [jsonResponse([pullRequest()])],
          ],
        ]),
        requests,
      ),
    });

    const result = await client.create(request());

    assert.deepEqual(result, {
      commitSha: COMMIT_SHA,
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.example/example/service/pull/17",
    });
    assert.deepEqual(requests, [
      {
        path: "/repos/example/service/git/ref/heads/main",
        method: "GET",
      },
      {
        path: `/repos/example/service/git/ref/heads/${ENCODED_BRANCH}`,
        method: "GET",
      },
      {
        path: `/repos/example/service/contents/${PATH}?ref=${ENCODED_BRANCH}`,
        method: "GET",
      },
      {
        path: `/repos/example/service/git/commits/${COMMIT_SHA}`,
        method: "GET",
      },
      {
        path: "/repos/example/service/git/ref/heads/main",
        method: "GET",
      },
      {
        path: "/repos/example/service/pulls?state=all&head=example%3Adocs%2Fproposal-123456789abc",
        method: "GET",
      },
    ]);
  });

  it("creates the trusted branch, one documentation commit, and one pull request", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new GitHubRepositoryPullRequestClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/repos/example/service/git/ref/heads/main",
            [jsonResponse(reference(BASE_SHA)), jsonResponse(reference(BASE_SHA))],
          ],
          [
            `/repos/example/service/git/ref/heads/${ENCODED_BRANCH}`,
            [jsonResponse({ message: "Not Found" }, 404)],
          ],
          [
            "/repos/example/service/git/refs",
            [jsonResponse(reference(BASE_SHA), 201)],
          ],
          [
            `/repos/example/service/contents/${PATH}?ref=${ENCODED_BRANCH}`,
            [jsonResponse(content(BASE_CONTENT, FILE_SHA))],
          ],
          [
            `/repos/example/service/contents/${PATH}`,
            [jsonResponse({ commit: { sha: COMMIT_SHA } })],
          ],
          [
            "/repos/example/service/pulls?state=all&head=example%3Adocs%2Fproposal-123456789abc",
            [jsonResponse([])],
          ],
          [
            "/repos/example/service/pulls",
            [jsonResponse(pullRequest(), 201)],
          ],
        ]),
        requests,
      ),
    });

    const result = await client.create(request());

    assert.equal(result.commitSha, COMMIT_SHA);
    assert.deepEqual(requests, [
      {
        path: "/repos/example/service/git/ref/heads/main",
        method: "GET",
      },
      {
        path: `/repos/example/service/git/ref/heads/${ENCODED_BRANCH}`,
        method: "GET",
      },
      {
        path: "/repos/example/service/git/refs",
        method: "POST",
        body: { ref: `refs/heads/${BRANCH}`, sha: BASE_SHA },
      },
      {
        path: `/repos/example/service/contents/${PATH}?ref=${ENCODED_BRANCH}`,
        method: "GET",
      },
      {
        path: `/repos/example/service/contents/${PATH}`,
        method: "PUT",
        body: {
          message: "docs: update docs/orders.md",
          content: Buffer.from(REPLACEMENT_CONTENT).toString("base64"),
          branch: BRANCH,
          sha: FILE_SHA,
        },
      },
      {
        path: "/repos/example/service/git/ref/heads/main",
        method: "GET",
      },
      {
        path: "/repos/example/service/pulls?state=all&head=example%3Adocs%2Fproposal-123456789abc",
        method: "GET",
      },
      {
        path: "/repos/example/service/pulls",
        method: "POST",
        body: {
          title: "docs: update docs/orders.md",
          head: BRANCH,
          base: "main",
          body: "Applies documentation proposal digest.",
        },
      },
    ]);
  });

  it("rejects a moved default branch without creating a branch or pull request", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new GitHubRepositoryPullRequestClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/repos/example/service/git/ref/heads/main",
            [jsonResponse(reference(COMMIT_SHA))],
          ],
        ]),
        requests,
      ),
    });

    await assert.rejects(
      client.create(request()),
      GitHubRepositoryPullRequestStaleBaseError,
    );
    assert.deepEqual(requests, [
      {
        path: "/repos/example/service/git/ref/heads/main",
        method: "GET",
      },
    ]);
  });
});

function request() {
  return {
    repositoryFullName: "example/service",
    defaultBranch: "main",
    baseSha: BASE_SHA,
    branchName: BRANCH,
    path: PATH,
    content: REPLACEMENT_CONTENT,
    commitMessage: "docs: update docs/orders.md",
    title: "docs: update docs/orders.md",
    body: "Applies documentation proposal digest.",
    idempotencyKey: "repository-pull-request:repository-pr-v1:digest",
  };
}

function reference(sha: string) {
  return { ref: "refs/heads/main", object: { type: "commit", sha } };
}

function content(value: string, sha: string) {
  return {
    type: "file",
    sha,
    content: Buffer.from(value).toString("base64"),
    encoding: "base64",
  };
}

function pullRequest() {
  return {
    number: 17,
    html_url: "https://github.example/example/service/pull/17",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFixtureFetch(
  fixtures: Map<string, Response[]>,
  requests: Array<{ path: string; method: string; body?: unknown }>,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, ...(body === undefined ? {} : { body }) });
    const response = fixtures.get(path)?.shift();
    if (!response) {
      return jsonResponse({ message: `No fixture for ${path}` }, 404);
    }
    return response.clone();
  };
}
