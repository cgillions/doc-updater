import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewJobContext } from "../../domain/review-jobs/review-job-context.ts";
import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import type {
  StoredConfluenceCandidate,
} from "../../database/confluence-page-store.ts";
import {
  AssignedConfluencePageReviewer,
  type ConfluenceCandidateStore,
} from "./review-confluence-pages.ts";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = "123e4567-e89b-42d3-a456-426614174001";
const AUTH = {
  current: null,
  initiator: {
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
    attributes: { reviewJobId: JOB_ID },
  },
};

describe("AssignedConfluencePageReviewer", () => {
  it("materializes only exact scoped pages and returns opaque candidates", async () => {
    const materialized: unknown[] = [];
    const store = fakeStore({
      materializeCandidates: async (reviewJobId, targets) => {
        materialized.push({ reviewJobId, targets });
        return [candidate()];
      },
      attachSnapshot: async () => candidate({
        snapshot: snapshot(),
      }),
    });
    const reviewer = new AssignedConfluencePageReviewer(
      { loadActive: async () => context() },
      store,
      { getPage: async (target) => page(target) },
    );

    const result = await reviewer.search(AUTH, {
      query: "team handbook",
      limit: 10,
    });

    assert.deepEqual(materialized, [{
      reviewJobId: JOB_ID,
      targets: [{
        siteId: "example.atlassian.net",
        pageId: "12345",
        label: "Team handbook",
      }],
    }]);
    assert.deepEqual(result, {
      candidates: [{
        candidateId: CANDIDATE_ID,
        label: "Team handbook",
        title: "Team handbook",
        version: 4,
        excerpt: "Preamble API",
        provenance: [{
          entityRef: "group:default/example",
          title: "Team handbook",
        }],
      }],
    });
  });

  it("rejects an opaque candidate outside the assigned job", async () => {
    const reviewer = new AssignedConfluencePageReviewer(
      { loadActive: async () => context() },
      fakeStore({ loadCandidate: async () => null }),
      { getPage: async () => { throw new Error("must not fetch"); } },
    );

    await assert.rejects(
      reviewer.get(AUTH, CANDIDATE_ID),
      ReviewRecordConflictError,
    );
  });

  it("preserves the native structured storage body for a scoped candidate", async () => {
    const storageValue =
      "<p>Preamble</p><h2>API</h2><ac:structured-macro ac:name=\"code\" />";
    const reviewer = new AssignedConfluencePageReviewer(
      { loadActive: async () => context() },
      fakeStore({
        loadCandidate: async () => candidate({
          snapshot: snapshot({ bodyStorageValue: storageValue }),
        }),
      }),
      { getPage: async (target) => page(target) },
    );

    const result = await reviewer.get(AUTH, CANDIDATE_ID);

    assert.equal(result.candidateId, CANDIDATE_ID);
    assert.equal(result.version, 4);
    assert.equal(result.bodyStorageValue, storageValue);
    assert.equal("siteId" in result, false);
    assert.equal("pageId" in result, false);
  });
});

function fakeStore(
  overrides: Partial<ConfluenceCandidateStore> = {},
): ConfluenceCandidateStore {
  return {
    materializeCandidates:
      overrides.materializeCandidates ?? (async () => []),
    loadCandidate:
      overrides.loadCandidate ?? (async () => candidate()),
    attachSnapshot:
      overrides.attachSnapshot ?? (async () => candidate()),
  };
}

function candidate(
  overrides: Partial<StoredConfluenceCandidate> = {},
): StoredConfluenceCandidate {
  return {
    id: CANDIDATE_ID,
    reviewJobId: JOB_ID,
    siteId: "example.atlassian.net",
    pageId: "12345",
    label: "Team handbook",
    snapshot: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<
    NonNullable<StoredConfluenceCandidate["snapshot"]>
  > = {},
): NonNullable<StoredConfluenceCandidate["snapshot"]> {
  return {
    id: "123e4567-e89b-42d3-a456-426614174002",
    siteId: "example.atlassian.net",
    pageId: "12345",
    version: 4,
    title: "Team handbook",
    bodyStorageValue: "<p>Preamble</p><h2>API</h2>",
    bodyHash: "d".repeat(64),
    ...overrides,
  };
}

function page(target: { siteId: string; pageId: string }) {
  return {
    ...target,
    version: 4,
    status: "current",
    title: "Team handbook",
    spaceId: "987",
    parentId: null,
    bodyStorageValue: "<p>Preamble</p><h2>API</h2>",
    bodyHash: "d".repeat(64),
    fetchedAt: new Date(),
  };
}

function context(): ReviewJobContext {
  return {
    reviewJobId: JOB_ID,
    mode: "INCREMENTAL",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    repository: {
      id: "123e4567-e89b-42d3-a456-426614174003",
      fullName: "example/service",
      defaultBranch: "main",
    },
    roadie: {
      componentRef: "component:default/service",
      systemRef: "system:default/example",
      ownerRef: "group:default/example",
      slackChannelId: "C12345678",
      catalogRevision: null,
      configurationHash: "c".repeat(64),
    },
    documentationScope: [
      {
        siteId: "example.atlassian.net",
        pageId: "12345",
        declarations: [{
          kind: "exact",
          excludedPageIds: [],
          provenance: {
            entityRef: "group:default/example",
            title: "Team handbook",
            url:
              "https://example.atlassian.net/wiki/spaces/EX/pages/12345",
          },
        }],
      },
      {
        siteId: "example.atlassian.net",
        pageId: "99999",
        declarations: [{
          kind: "root",
          excludedPageIds: [],
          provenance: {
            entityRef: "group:default/example",
            title: "Root",
            url:
              "https://example.atlassian.net/wiki/spaces/EX/pages/99999",
          },
        }],
      },
    ],
  };
}
