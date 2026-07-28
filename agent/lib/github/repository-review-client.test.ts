import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitHubRepositoryReviewClient,
  GitHubRepositoryReviewLimitError,
  InvalidRepositoryPathError,
} from "./repository-review-client.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

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
              files: [
                { filename: "src/api.ts", status: "modified" },
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
      changedFiles: [
        { path: "src/api.ts", status: "modified" },
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
            jsonResponse({ files: [] }),
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
