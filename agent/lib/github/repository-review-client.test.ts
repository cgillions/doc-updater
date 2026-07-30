import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitHubRepositoryReviewClient,
  GitHubRepositoryReviewLimitError,
  InvalidRepositoryPathError,
} from "./repository-review-client.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const FIRST_COMMIT_SHA = "c".repeat(40);
const SECOND_COMMIT_SHA = "d".repeat(40);
const THIRD_COMMIT_SHA = "e".repeat(40);

describe("GitHubRepositoryReviewClient", () => {
  it("loads changed implementation paths and repository documentation at the assigned SHAs", async () => {
    const requests: string[] = [];
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
            jsonResponse({
              total_commits: 2,
              commits: [
                {
                  sha: FIRST_COMMIT_SHA,
                  commit: { message: "Add the API behavior" },
                  parents: [{ sha: BASE_SHA }],
                },
                {
                  sha: SECOND_COMMIT_SHA,
                  commit: { message: "Document the API behavior" },
                  parents: [{ sha: FIRST_COMMIT_SHA }],
                },
              ],
              files: [
                {
                  filename: "src/api.ts",
                  status: "modified",
                  patch: "@@ -1 +1 @@\n-old\n+new",
                },
                {
                  filename: "docs/new-name.md",
                  previous_filename: "docs/old-name.md",
                  status: "renamed",
                },
              ],
            }),
          ],
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                { path: "src/api.ts", type: "blob" },
                { path: "README.md", type: "blob" },
                { path: "docs/operations.mdx", type: "blob" },
                { path: "notes.txt", type: "blob" },
                { path: "docs/archive", type: "tree" },
              ],
            }),
          ],
        ]),
        requests,
      ),
    });

    const scope = await client.loadScope({
      repositoryFullName: "example/service",
      mode: "INCREMENTAL",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });

    assert.deepEqual(scope, {
      mode: "INCREMENTAL",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      commits: [
        {
          sha: FIRST_COMMIT_SHA,
          message: "Add the API behavior",
          parentShas: [BASE_SHA],
        },
        {
          sha: SECOND_COMMIT_SHA,
          message: "Document the API behavior",
          parentShas: [FIRST_COMMIT_SHA],
        },
      ],
      changedFiles: [
        {
          path: "src/api.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
        {
          path: "docs/new-name.md",
          previousPath: "docs/old-name.md",
          status: "renamed",
        },
      ],
      documentationFiles: ["README.md", "docs/operations.mdx"],
    });
    assert.deepEqual(requests, [
      `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
      `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
    ]);
  });

  it("preserves final patches and commit order across a noisy reverted range", async () => {
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
            jsonResponse({
              total_commits: 3,
              commits: [
                {
                  sha: FIRST_COMMIT_SHA,
                  commit: { message: "Temporarily revise the guide" },
                  parents: [{ sha: BASE_SHA }],
                },
                {
                  sha: SECOND_COMMIT_SHA,
                  commit: { message: "Revert the guide revision" },
                  parents: [{ sha: FIRST_COMMIT_SHA }],
                },
                {
                  sha: THIRD_COMMIT_SHA,
                  commit: { message: "Change runtime behavior" },
                  parents: [{ sha: SECOND_COMMIT_SHA }],
                },
              ],
              files: [
                {
                  filename: "src/runtime.ts",
                  status: "modified",
                  patch:
                    "@@ -10 +10 @@\n" +
                    "-const policy = previousPolicy();\n" +
                    "+const policy = currentPolicy();",
                },
              ],
            }),
          ],
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                { path: "src/runtime.ts", type: "blob" },
                { path: "docs/guide.md", type: "blob" },
              ],
            }),
          ],
        ]),
      ),
    });

    const scope = await client.loadScope({
      repositoryFullName: "example/service",
      mode: "INCREMENTAL",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });

    assert.deepEqual(
      scope.commits.map(({ sha, message }) => ({ sha, message })),
      [
        {
          sha: FIRST_COMMIT_SHA,
          message: "Temporarily revise the guide",
        },
        {
          sha: SECOND_COMMIT_SHA,
          message: "Revert the guide revision",
        },
        {
          sha: THIRD_COMMIT_SHA,
          message: "Change runtime behavior",
        },
      ],
    );
    assert.equal(
      scope.changedFiles[0]?.patch,
      "@@ -10 +10 @@\n" +
        "-const policy = previousPolicy();\n" +
        "+const policy = currentPolicy();",
    );
    assert.deepEqual(scope.documentationFiles, ["docs/guide.md"]);
  });

  it("uses the head tree as changed input for reconciliation reviews", async () => {
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                { path: "src/api.ts", type: "blob" },
                { path: "README.md", type: "blob" },
              ],
            }),
          ],
        ]),
      ),
    });

    const scope = await client.loadScope({
      repositoryFullName: "example/service",
      mode: "RECONCILIATION",
      baseSha: null,
      headSha: HEAD_SHA,
    });

    assert.deepEqual(scope.changedFiles, [
      { path: "README.md", status: "present" },
      { path: "src/api.ts", status: "present" },
    ]);
    assert.deepEqual(scope.documentationFiles, ["README.md"]);
  });

  it("fails closed when GitHub truncates a tree or comparison", async () => {
    const truncatedTreeClient = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
            jsonResponse({
              total_commits: 0,
              commits: [],
              files: [],
            }),
          ],
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({ truncated: true, tree: [] }),
          ],
        ]),
      ),
    });

    await assert.rejects(
      truncatedTreeClient.loadScope({
        repositoryFullName: "example/service",
        mode: "INCREMENTAL",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      }),
      (error: unknown) =>
        error instanceof GitHubRepositoryReviewLimitError &&
        error.limit === "tree",
    );

    const comparisonClient = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
            jsonResponse({
              total_commits: 0,
              commits: [],
              files: Array.from({ length: 300 }, (_, index) => ({
                filename: `src/file-${index}.ts`,
                status: "modified",
              })),
            }),
          ],
        ]),
      ),
    });

    await assert.rejects(
      comparisonClient.loadScope({
        repositoryFullName: "example/service",
        mode: "INCREMENTAL",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      }),
      (error: unknown) =>
        error instanceof GitHubRepositoryReviewLimitError &&
        error.limit === "comparison",
    );

    const truncatedCommitsClient = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/compare/${BASE_SHA}...${HEAD_SHA}`,
            jsonResponse({
              total_commits: 2,
              commits: [
                {
                  sha: FIRST_COMMIT_SHA,
                  commit: { message: "First change" },
                  parents: [{ sha: BASE_SHA }],
                },
              ],
              files: [],
            }),
          ],
        ]),
      ),
    });

    await assert.rejects(
      truncatedCommitsClient.loadScope({
        repositoryFullName: "example/service",
        mode: "INCREMENTAL",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      }),
      (error: unknown) =>
        error instanceof GitHubRepositoryReviewLimitError &&
        error.limit === "comparison",
    );
  });

  it("reads bounded UTF-8 content at the requested assigned revision", async () => {
    const requests: string[] = [];
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/contents/docs/guide.md?ref=${BASE_SHA}`,
            textResponse("# Guide\n"),
          ],
        ]),
        requests,
      ),
    });

    const file = await client.readFile({
      repositoryFullName: "example/service",
      path: "docs/guide.md",
      revision: "base",
      gitSha: BASE_SHA,
    });

    assert.equal(file.content, "# Guide\n");
    assert.equal(file.byteLength, 8);
    assert.equal(
      file.contentSha256,
      "bc553ffe57e544498b12a9865dbf3abc2004c474e349c52c378eaa402287424b",
    );
    assert.deepEqual(requests, [
      `/repos/example/service/contents/docs/guide.md?ref=${BASE_SHA}`,
    ]);
  });

  it("rejects unsafe paths and files over the configured evidence limit", async () => {
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/contents/docs/large.md?ref=${HEAD_SHA}`,
            textResponse("content"),
          ],
        ]),
      ),
      maxFileBytes: 4,
    });

    await assert.rejects(
      client.readFile({
        repositoryFullName: "example/service",
        path: "../secret",
        revision: "head",
        gitSha: HEAD_SHA,
      }),
      InvalidRepositoryPathError,
    );
    await assert.rejects(
      client.readFile({
        repositoryFullName: "example/service",
        path: "docs/large.md",
        revision: "head",
        gitSha: HEAD_SHA,
      }),
      (error: unknown) =>
        error instanceof GitHubRepositoryReviewLimitError &&
        error.limit === "file",
    );
  });

  it("searches bounded snippets at the assigned revision and excludes unsafe paths", async () => {
    const requests: string[] = [];
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                {
                  path: "src/review-cursor.ts",
                  type: "blob",
                  size: 98,
                },
                {
                  path: "agent/lib/database/generated/client.ts",
                  type: "blob",
                  size: 98,
                },
                { path: "node_modules/pkg/index.ts", type: "blob", size: 98 },
                { path: "package-lock.json", type: "blob", size: 98 },
                { path: ".env", type: "blob", size: 98 },
                { path: "certs/service.key", type: "blob", size: 98 },
              ],
            }),
          ],
          [
            `/repos/example/service/contents/src/review-cursor.ts?ref=${HEAD_SHA}`,
            textResponse(
              "export const field = 'lastSuccessfullyReviewedSha';\n",
            ),
          ],
        ]),
        requests,
      ),
    });

    const response = await client.search(
      {
        repositoryFullName: "example/service",
        revision: "head",
        gitSha: HEAD_SHA,
      },
      {
        query: "lastSuccessfullyReviewedSha",
        maxResults: 10,
      },
    );

    assert.deepEqual(response.results, [
      {
        path: "src/review-cursor.ts",
        lineNumber: 1,
        snippet: "export const field = 'lastSuccessfullyReviewedSha';",
      },
    ]);
    assert.equal(response.searchedFileCount, 1);
    assert.equal(response.skippedFileCount, 5);
    assert.equal(response.truncated, false);
    assert.deepEqual(requests, [
      `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
      `/repos/example/service/contents/src/review-cursor.ts?ref=${HEAD_SHA}`,
    ]);
  });

  it("redacts obvious secrets from search snippets", async () => {
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                { path: "src/config.ts", type: "blob", size: 64 },
              ],
            }),
          ],
          [
            `/repos/example/service/contents/src/config.ts?ref=${HEAD_SHA}`,
            textResponse('const token = "super-secret-value";\n'),
          ],
        ]),
      ),
    });

    const response = await client.search(
      {
        repositoryFullName: "example/service",
        revision: "head",
        gitSha: HEAD_SHA,
      },
      {
        query: "token",
        maxResults: 10,
      },
    );

    assert.equal(response.results[0]?.snippet, "const token = [REDACTED];");
  });

  it("enforces search file and result bounds", async () => {
    const client = new GitHubRepositoryReviewClient({
      getAccessToken: async () => "installation-token",
      fetch: createFixtureFetch(
        new Map([
          [
            `/repos/example/service/git/trees/${HEAD_SHA}?recursive=1`,
            jsonResponse({
              truncated: false,
              tree: [
                { path: "src/a.ts", type: "blob", size: 10 },
                { path: "src/b.ts", type: "blob", size: 10 },
                { path: "src/c.ts", type: "blob", size: 10 },
              ],
            }),
          ],
          [
            `/repos/example/service/contents/src/a.ts?ref=${HEAD_SHA}`,
            textResponse("needle one\nneedle two\n"),
          ],
          [
            `/repos/example/service/contents/src/b.ts?ref=${HEAD_SHA}`,
            textResponse("needle three\n"),
          ],
        ]),
      ),
      maxSearchFiles: 2,
    });

    const response = await client.search(
      {
        repositoryFullName: "example/service",
        revision: "head",
        gitSha: HEAD_SHA,
      },
      {
        query: "needle",
        maxResults: 2,
      },
    );

    assert.equal(response.results.length, 2);
    assert.equal(response.truncated, true);
    assert.equal(response.skippedFileCount, 1);
  });
});

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/octet-stream" },
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
    return (
      fixtures.get(requestPath)?.clone() ??
      jsonResponse({ message: `No fixture for ${requestPath}` }, 404)
    );
  };
}
