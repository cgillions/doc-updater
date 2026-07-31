import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConfluencePageUpdateArtifactStore } from "../../database/confluence-page-update-store.ts";
import type { ConfluenceDraftProposal } from "../../database/confluence-draft-store.ts";
import {
  hashConfluenceBody,
  type ConfluencePage,
} from "../../domain/documentation/confluence-page.ts";
import type {
  ConfluenceDraftBlockedRecord,
  ConfluencePageUpdateRecord,
} from "../../domain/reviews/review-records.ts";
import {
  ConfluencePageUpdateStalePageError,
  publishAssignedConfluencePageUpdate,
  type ConfluencePageReader,
  type ConfluencePageUpdater,
} from "./publish-confluence-page-update.ts";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const DIGEST = "c".repeat(64);
const AUTH = {
  current: {
    authenticator: "slack",
    principalId: "U12345678",
    principalType: "user",
    attributes: {},
  },
  initiator: {
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
    attributes: { reviewJobId: JOB_ID },
  },
};

describe("publishAssignedConfluencePageUpdate", () => {
  it("revalidates and publishes only the exact persisted replacement", async () => {
    const store = new FakeStore();
    const updater = new FakeUpdater();
    const result = await publishAssignedConfluencePageUpdate(
      AUTH,
      { proposalDigest: DIGEST },
      {
        store,
        pages: new FakePages(page()),
        updater,
        audit: { sessionId: "session-1", toolCallId: "call-1" },
      },
    );

    assert.deepEqual(result, publishedRecord());
    assert.equal(
      updater.calls[0]?.bodyStorageValue,
      "<h2>Orders</h2><p>Updated</p><p>Tail</p>",
    );
    assert.deepEqual(store.published, {
      proposal: proposal(),
      pageId: "12345",
      publishedVersion: 8,
      pageUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
      historyUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
      status: "published",
      actorId: "U12345678",
      sessionId: "session-1",
      toolCallId: "call-1",
    });
  });

  it("does not write when the published baseline has changed", async () => {
    const updater = new FakeUpdater();
    await assert.rejects(
      publishAssignedConfluencePageUpdate(
        AUTH,
        { proposalDigest: DIGEST },
        {
          store: new FakeStore(),
          pages: new FakePages({ ...page(), version: 8 }),
          updater,
        },
      ),
      ConfluencePageUpdateStalePageError,
    );
    assert.equal(updater.calls.length, 0);
  });

  it("preserves a real existing draft without reading or updating the page", async () => {
    const store = new FakeStore();
    const pages = new FakePages(page(), { pageId: "12345", version: 2 });
    const updater = new FakeUpdater();
    const result = await publishAssignedConfluencePageUpdate(
      AUTH,
      { proposalDigest: DIGEST },
      { store, pages, updater },
    );

    assert.equal(result.status, "blocked-existing-draft");
    assert.equal(pages.pageReads, 0);
    assert.equal(updater.calls.length, 0);
    assert.equal(store.blocked?.existingDraftVersion, 2);
  });
});

class FakeStore implements ConfluencePageUpdateArtifactStore {
  published:
    | Parameters<ConfluencePageUpdateArtifactStore["recordPublished"]>[0]
    | undefined;
  blocked:
    | Parameters<
        ConfluencePageUpdateArtifactStore["recordBlockedByExistingDraft"]
      >[0]
    | undefined;

  async loadProposal() {
    return proposal();
  }

  async withPageLock<TResult>(
    _target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ) {
    return action();
  }

  async recordPublished(
    input: Parameters<ConfluencePageUpdateArtifactStore["recordPublished"]>[0],
  ): Promise<ConfluencePageUpdateRecord> {
    this.published = input;
    return publishedRecord();
  }

  async recordBlockedByExistingDraft(
    input: Parameters<
      ConfluencePageUpdateArtifactStore["recordBlockedByExistingDraft"]
    >[0],
  ): Promise<ConfluenceDraftBlockedRecord> {
    this.blocked = input;
    return {
      proposalDigest: DIGEST,
      pageId: "12345",
      status: "blocked-existing-draft",
    };
  }
}

class FakePages implements ConfluencePageReader {
  pageReads = 0;
  private readonly current: ConfluencePage;
  private readonly draft: { pageId: string; version: number } | null;

  constructor(
    current: ConfluencePage,
    draft: { pageId: string; version: number } | null = null,
  ) {
    this.current = current;
    this.draft = draft;
  }

  async getPage() {
    this.pageReads += 1;
    return this.current;
  }

  async getDraftState() {
    return this.draft;
  }
}

class FakeUpdater implements ConfluencePageUpdater {
  readonly calls: Parameters<ConfluencePageUpdater["updatePage"]>[0][] = [];

  async updatePage(input: Parameters<ConfluencePageUpdater["updatePage"]>[0]) {
    this.calls.push(input);
    return {
      pageId: "12345",
      publishedVersion: 8,
      pageUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
      historyUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
      status: "published" as const,
    };
  }
}

function proposal(): ConfluenceDraftProposal {
  return {
    id: "123e4567-e89b-42d3-a456-426614174001",
    repositoryId: "123e4567-e89b-42d3-a456-426614174002",
    reviewJobId: JOB_ID,
    digest: DIGEST,
    implementationSha: "b".repeat(40),
    target: {
      siteId: "example.atlassian.net",
      pageId: "12345",
      version: 7,
      bodyHash: "d".repeat(64),
    },
    patch: {
      baselineStorageValue: "<p>Current</p>",
      baselineFragmentHash: hashConfluenceBody("<p>Current</p>"),
      replacementStorageValue: "<p>Updated</p>",
    },
  };
}

function page(): ConfluencePage {
  return {
    siteId: "example.atlassian.net",
    pageId: "12345",
    version: 7,
    status: "current",
    title: "Orders",
    spaceId: "987",
    parentId: "456",
    bodyStorageValue: "<h2>Orders</h2><p>Current</p><p>Tail</p>",
    bodyHash: "d".repeat(64),
    fetchedAt: new Date("2026-07-29T12:00:00.000Z"),
  };
}

function publishedRecord(): ConfluencePageUpdateRecord {
  return {
    proposalDigest: DIGEST,
    pageId: "12345",
    publishedVersion: 8,
    pageUrl:
      "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
    historyUrl:
      "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
    status: "published",
  };
}
