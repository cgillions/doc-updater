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
            changedFiles: [],
            documentationFiles: [],
          };
        },
        readFile: async () => {
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
      },
    );

    await assert.rejects(
      reader.readFile(AUTH, { path: "README.md", revision: "base" }),
      BaseRevisionUnavailableError,
    );
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

