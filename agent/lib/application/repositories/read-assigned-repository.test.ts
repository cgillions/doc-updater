import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewJobContext } from "../../domain/review-jobs/review-job-context.ts";
import {
  AssignedRepositoryReader,
  BaseRevisionUnavailableError,
} from "./read-assigned-repository.ts";

const REVIEW_JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const AUTH = {
  current: null,
  initiator: {
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
    attributes: { reviewJobId: REVIEW_JOB_ID },
  },
};

describe("AssignedRepositoryReader", () => {
  it("loads scope using only coordinates from the assigned job", async () => {
    const calls: unknown[] = [];
    const reader = new AssignedRepositoryReader(
      {
        loadActive: async () => incrementalContext(),
      },
      {
        loadScope: async (coordinates) => {
          calls.push(coordinates);
          return {
            mode: coordinates.mode,
            baseSha: coordinates.baseSha,
            headSha: coordinates.headSha,
            commits: [],
            changedFiles: [],
            documentationFiles: [],
          };
        },
        readFile: async () => {
          throw new Error("not used");
        },
        search: async () => {
          throw new Error("not used");
        },
      },
    );

    await reader.loadScope(AUTH);

    assert.deepEqual(calls, [
      {
        repositoryFullName: "example/service",
        mode: "INCREMENTAL",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    ]);
  });

  it("binds file reads to the selected assigned revision", async () => {
    const calls: unknown[] = [];
    const reader = new AssignedRepositoryReader(
      {
        loadActive: async () => incrementalContext(),
      },
      {
        loadScope: async () => {
          throw new Error("not used");
        },
        readFile: async (coordinates) => {
          calls.push(coordinates);
          return {
            path: coordinates.path,
            revision: coordinates.revision,
            gitSha: coordinates.gitSha,
            byteLength: 0,
            contentSha256: "c".repeat(64),
            content: "",
          };
        },
        search: async () => {
          throw new Error("not used");
        },
      },
    );

    await reader.readFile(AUTH, {
      path: "docs/guide.md",
      revision: "base",
    });
    await reader.readFile(AUTH, {
      path: "src/api.ts",
      revision: "head",
    });

    assert.deepEqual(calls, [
      {
        repositoryFullName: "example/service",
        path: "docs/guide.md",
        revision: "base",
        gitSha: BASE_SHA,
      },
      {
        repositoryFullName: "example/service",
        path: "src/api.ts",
        revision: "head",
        gitSha: HEAD_SHA,
      },
    ]);
  });

  it("rejects base reads for reconciliation jobs", async () => {
    const reader = new AssignedRepositoryReader(
      {
        loadActive: async () => ({
          ...incrementalContext(),
          mode: "RECONCILIATION",
          baseSha: null,
        }),
      },
      {
        loadScope: async () => {
          throw new Error("not used");
        },
        readFile: async () => {
          throw new Error("must not read");
        },
        search: async () => {
          throw new Error("must not search");
        },
      },
    );

    await assert.rejects(
      reader.readFile(AUTH, { path: "README.md", revision: "base" }),
      BaseRevisionUnavailableError,
    );
  });

  it("binds search to the selected assigned revision and audits returned paths", async () => {
    const searchCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const reader = new AssignedRepositoryReader(
      {
        loadActive: async () => incrementalContext(),
      },
      {
        loadScope: async () => {
          throw new Error("not used");
        },
        readFile: async () => {
          throw new Error("not used");
        },
        search: async (coordinates, request) => {
          searchCalls.push({ coordinates, request });
          return {
            query: request.query,
            revision: coordinates.revision,
            gitSha: coordinates.gitSha,
            results: [
              {
                path: "agent/lib/database/review-completion-store.ts",
                lineNumber: 213,
                snippet: "lastSuccessfullyReviewedSha: headSha,",
              },
              {
                path: "agent/lib/database/review-completion-store.ts",
                lineNumber: 217,
                snippet: "lastSuccessfullyReviewedSha: headSha,",
              },
            ],
            searchedFileCount: 4,
            skippedFileCount: 2,
            truncated: false,
            guidance:
              "Search results are discovery snippets only; call read_repository_file.",
          };
        },
      },
    );

    const result = await reader.search(
      { ...AUTH, current: { ...AUTH.initiator, principalId: "U123" } },
      {
        query: "lastSuccessfullyReviewedSha",
        revision: "head",
        maxResults: 5,
      },
      {
        recordSearch: async (input) => {
          auditCalls.push(input);
        },
      },
      { toolCallId: "call-123" },
    );

    assert.deepEqual(searchCalls, [
      {
        coordinates: {
          repositoryFullName: "example/service",
          revision: "head",
          gitSha: HEAD_SHA,
        },
        request: {
          query: "lastSuccessfullyReviewedSha",
          maxResults: 5,
        },
      },
    ]);
    assert.deepEqual(auditCalls, [
      {
        reviewJobId: REVIEW_JOB_ID,
        repositoryId: "123e4567-e89b-42d3-a456-426614174001",
        revision: "head",
        gitSha: HEAD_SHA,
        query: "lastSuccessfullyReviewedSha",
        returnedPaths: ["agent/lib/database/review-completion-store.ts"],
        resultCount: 2,
        truncated: false,
        actorId: "U123",
        toolCallId: "call-123",
      },
    ]);
    assert.equal(result.results.length, 2);
  });

  it("audits failed repository search attempts before rethrowing", async () => {
    const auditCalls: unknown[] = [];
    const reader = new AssignedRepositoryReader(
      {
        loadActive: async () => incrementalContext(),
      },
      {
        loadScope: async () => {
          throw new Error("not used");
        },
        readFile: async () => {
          throw new Error("not used");
        },
        search: async () => {
          throw new Error("GitHub truncated the recursive repository tree.");
        },
      },
    );

    await assert.rejects(
      reader.search(
        AUTH,
        {
          query: "lastSuccessfullyReviewedSha",
          revision: "head",
          maxResults: 5,
        },
        {
          recordSearch: async (input) => {
            auditCalls.push(input);
          },
        },
        { toolCallId: "call-failed" },
      ),
      /GitHub truncated/,
    );

    assert.deepEqual(auditCalls, [
      {
        reviewJobId: REVIEW_JOB_ID,
        repositoryId: "123e4567-e89b-42d3-a456-426614174001",
        revision: "head",
        gitSha: HEAD_SHA,
        query: "lastSuccessfullyReviewedSha",
        returnedPaths: [],
        resultCount: 0,
        truncated: true,
        errorMessage: "GitHub truncated the recursive repository tree.",
        actorId: undefined,
        toolCallId: "call-failed",
      },
    ]);
  });
});

function incrementalContext(): ReviewJobContext {
  return {
    reviewJobId: REVIEW_JOB_ID,
    mode: "INCREMENTAL",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    repository: {
      id: "123e4567-e89b-42d3-a456-426614174001",
      fullName: "example/service",
      defaultBranch: "main",
    },
    roadie: {
      componentRef: "component:default/service",
      systemRef: "system:default/example",
      ownerRef: "group:default/example",
      slackChannelId: "C12345678",
      catalogRevision: null,
      configurationHash: "d".repeat(64),
    },
    documentationScope: [],
  };
}
