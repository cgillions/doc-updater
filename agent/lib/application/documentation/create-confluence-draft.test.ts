import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hashConfluenceBody,
  type ConfluencePage,
} from "../../domain/documentation/confluence-page.ts";
import type {
  ConfluenceDraftBlockedRecord,
  ConfluenceDraftRecord,
} from "../../domain/reviews/review-records.ts";
import {
  ConfluenceDraftStalePageError,
  ConfluenceDraftUnavailableError,
  createAssignedConfluenceDraft,
  type ConfluenceDraftCreator,
  type ConfluencePageReader,
} from "./create-confluence-draft.ts";
import type {
  ConfluenceDraftArtifactStore,
  ConfluenceDraftProposal,
} from "../../database/confluence-draft-store.ts";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROPOSAL_DIGEST = "c".repeat(64);
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

describe("createAssignedConfluenceDraft", () => {
  it("revalidates the exact page and preserves native content outside one proposed fragment", async () => {
    const store = new FakeDraftStore(proposal());
    const pages = new FakePageReader(page());
    const drafts = new FakeDraftCreator();

    const result = await createAssignedConfluenceDraft(
      AUTH,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, pages, drafts, audit: { sessionId: "session-123", toolCallId: "call-123" } },
    );

    assert.deepEqual(result, draftRecord());
    assert.equal(drafts.calls.length, 1);
    assert.deepEqual(drafts.calls[0], {
      page: page(),
      bodyStorageValue:
        '<h2>Orders</h2><p>Updated</p><ac:structured-macro ac:name="code" />',
      auditMessage:
        `Documentation proposal ${PROPOSAL_DIGEST} for review ${JOB_ID} ` +
        `at source ${"b".repeat(40)}.`,
    });
    assert.deepEqual(store.recorded, {
      proposal: proposal(),
      draftPageId: "12345",
      draftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });
  });

  it("invalidates a stale proposal without writing or merging against newer content", async () => {
    const store = new FakeDraftStore(proposal());
    const pages = new FakePageReader({ ...page(), version: 8 });
    const drafts = new FakeDraftCreator();

    await assert.rejects(
      createAssignedConfluenceDraft(
        AUTH,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, pages, drafts },
      ),
      ConfluenceDraftStalePageError,
    );
    assert.equal(drafts.calls.length, 0);
    assert.equal(store.recorded, undefined);
  });

  it("preserves an externally reported draft without reading or writing the page", async () => {
    const store = new FakeDraftStore(proposal());
    const pages = new FakePageReader(page(), { pageId: "12345", version: 8 });
    const drafts = new FakeDraftCreator();

    const result = await createAssignedConfluenceDraft(
      AUTH,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, pages, drafts, audit: { sessionId: "session-123", toolCallId: "call-123" } },
    );

    assert.deepEqual(result, {
      proposalDigest: PROPOSAL_DIGEST,
      pageId: "12345",
      status: "blocked-existing-draft",
    });
    assert.equal(pages.calls.length, 0);
    assert.deepEqual(pages.draftStateCalls, [proposal().target]);
    assert.equal(drafts.calls.length, 0);
    assert.deepEqual(store.blocked, {
      proposal: proposal(),
      existingDraftVersion: 8,
      actorId: "U12345678",
      sessionId: "session-123",
      toolCallId: "call-123",
    });
  });

  it("rejects a proposal outside the assigned review job", async () => {
    const store = new FakeDraftStore(null);
    const pages = new FakePageReader(page());
    const drafts = new FakeDraftCreator();

    await assert.rejects(
      createAssignedConfluenceDraft(
        AUTH,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, pages, drafts },
      ),
      ConfluenceDraftUnavailableError,
    );
    assert.equal(pages.calls.length, 0);
    assert.equal(drafts.calls.length, 0);
  });
});

class FakeDraftStore implements ConfluenceDraftArtifactStore {
  recorded: Parameters<ConfluenceDraftArtifactStore["recordCreated"]>[0] | undefined;
  blocked:
    | Parameters<ConfluenceDraftArtifactStore["recordBlockedByExistingDraft"]>[0]
    | undefined;
  private readonly storedProposal: ConfluenceDraftProposal | null;

  constructor(storedProposal: ConfluenceDraftProposal | null) {
    this.storedProposal = storedProposal;
  }

  async loadProposal(): Promise<ConfluenceDraftProposal | null> {
    return this.storedProposal;
  }

  async withPageLock<TResult>(
    _target: { siteId: string; pageId: string },
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    return action();
  }

  async recordCreated(
    input: Parameters<ConfluenceDraftArtifactStore["recordCreated"]>[0],
  ): Promise<ConfluenceDraftRecord> {
    this.recorded = input;
    return draftRecord();
  }

  async recordBlockedByExistingDraft(
    input: Parameters<ConfluenceDraftArtifactStore["recordBlockedByExistingDraft"]>[0],
  ): Promise<ConfluenceDraftBlockedRecord> {
    this.blocked = input;
    return {
      proposalDigest: PROPOSAL_DIGEST,
      pageId: "12345",
      status: "blocked-existing-draft" as const,
    };
  }
}

class FakePageReader implements ConfluencePageReader {
  readonly calls: Array<{ siteId: string; pageId: string }> = [];
  readonly draftStateCalls: Array<{ siteId: string; pageId: string }> = [];
  private readonly currentPage: ConfluencePage;
  private readonly draftState: { pageId: string; version: number } | null;

  constructor(
    currentPage: ConfluencePage,
    draftState: { pageId: string; version: number } | null = null,
  ) {
    this.currentPage = currentPage;
    this.draftState = draftState;
  }

  async getPage(target: { siteId: string; pageId: string }): Promise<ConfluencePage> {
    this.calls.push(target);
    return this.currentPage;
  }

  async getDraftState(target: { siteId: string; pageId: string }) {
    this.draftStateCalls.push(target);
    return this.draftState;
  }
}

class FakeDraftCreator implements ConfluenceDraftCreator {
  readonly calls: Parameters<ConfluenceDraftCreator["createDraft"]>[0][] = [];

  async createDraft(
    input: Parameters<ConfluenceDraftCreator["createDraft"]>[0],
  ) {
    this.calls.push(input);
    return {
      draftPageId: "12345",
      draftVersion: 8,
      status: "draft" as const,
    };
  }
}

function proposal(): ConfluenceDraftProposal {
  return {
    id: "123e4567-e89b-42d3-a456-426614174001",
    repositoryId: "123e4567-e89b-42d3-a456-426614174002",
    reviewJobId: JOB_ID,
    digest: PROPOSAL_DIGEST,
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
    bodyStorageValue:
      '<h2>Orders</h2><p>Current</p><ac:structured-macro ac:name="code" />',
    bodyHash: "d".repeat(64),
    fetchedAt: new Date("2026-07-29T12:00:00.000Z"),
  };
}

function draftRecord(): ConfluenceDraftRecord {
  return {
    proposalDigest: PROPOSAL_DIGEST,
    pageId: "12345",
    draftPageId: "12345",
    draftVersion: 8,
    status: "draft",
  };
}
