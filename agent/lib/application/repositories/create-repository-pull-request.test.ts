import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAssignedRepositoryPullRequest,
  RepositoryPullRequestStaleBaseError,
  RepositoryPullRequestUnavailableError,
  type RepositoryPullRequestArtifactStore,
  type RepositoryPullRequestCreator,
  type RepositoryPullRequestProposal,
} from "./create-repository-pull-request.ts";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_DIGEST = "a".repeat(64);
const BASE_SHA = "b".repeat(40);
const CURRENT_SHA = "c".repeat(40);

const scheduleAuth = {
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
    attributes: { reviewJobId: REVIEW_JOB_ID },
  },
};

describe("createAssignedRepositoryPullRequest", () => {
  it("creates one pull request from a stored proposal without accepting model-authored scope", async () => {
    const store = new FakeArtifactStore(proposal());
    const github = new FakePullRequestCreator(BASE_SHA);

    const result = await createAssignedRepositoryPullRequest(
      scheduleAuth,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, github },
    );

    assert.deepEqual(result, {
      proposalDigest: PROPOSAL_DIGEST,
      baseSha: BASE_SHA,
      branchName: "docs/proposal-64f9f1aac2a3",
      commitSha: "d".repeat(40),
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.example/example/service/pull/17",
    });
    assert.deepEqual(github.createInputs, [
      {
        repositoryFullName: "example/service",
        defaultBranch: "main",
        baseSha: BASE_SHA,
        branchName: "docs/proposal-64f9f1aac2a3",
        path: "docs/orders.md",
        content: "# Orders\n\nUse an idempotency key.\n",
        commitMessage: "docs: update docs/orders.md",
        title: "docs: update docs/orders.md",
        body: `Applies documentation proposal ${PROPOSAL_DIGEST}.`,
        idempotencyKey:
          "repository-pull-request:repository-pr-v1:2d0e33331dfbbce25b9821a1268a84b5fce6c11fe628efd9c7fa64f9f1aac2a3",
      },
    ]);
    assert.equal(store.recorded.length, 1);
    assert.equal(store.recorded[0]?.actorId, "U12345678");
  });

  it("returns the recorded artifact without calling GitHub on an idempotent replay", async () => {
    const store = new FakeArtifactStore(proposal());
    const github = new FakePullRequestCreator(BASE_SHA);
    const first = await createAssignedRepositoryPullRequest(
      scheduleAuth,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, github },
    );

    const replay = await createAssignedRepositoryPullRequest(
      scheduleAuth,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, github },
    );

    assert.deepEqual(replay, first);
    assert.equal(github.readHeadCalls, 1);
    assert.equal(github.createInputs.length, 1);
    assert.equal(store.recorded.length, 1);
  });

  it("retries after a GitHub failure with the same deterministic branch and idempotency key", async () => {
    const store = new FakeArtifactStore(proposal());
    const github = new FakePullRequestCreator(BASE_SHA, true);

    await assert.rejects(
      createAssignedRepositoryPullRequest(
        scheduleAuth,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, github },
      ),
      /temporary GitHub failure/,
    );
    const result = await createAssignedRepositoryPullRequest(
      scheduleAuth,
      { proposalDigest: PROPOSAL_DIGEST },
      { store, github },
    );

    assert.equal(result.branchName, "docs/proposal-64f9f1aac2a3");
    assert.equal(github.createInputs.length, 2);
    assert.equal(
      github.createInputs[0]?.idempotencyKey,
      github.createInputs[1]?.idempotencyKey,
    );
    assert.equal(
      github.createInputs[0]?.branchName,
      github.createInputs[1]?.branchName,
    );
  });

  it("rejects a stale default branch before creating any repository artifact", async () => {
    const store = new FakeArtifactStore(proposal());
    const github = new FakePullRequestCreator(CURRENT_SHA);

    await assert.rejects(
      createAssignedRepositoryPullRequest(
        scheduleAuth,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, github },
      ),
      RepositoryPullRequestStaleBaseError,
    );
    assert.equal(github.createInputs.length, 0);
    assert.equal(store.recorded.length, 0);
  });

  it("rejects a proposal digest outside the trusted scheduled job", async () => {
    const store = new FakeArtifactStore(null);
    const github = new FakePullRequestCreator(BASE_SHA);

    await assert.rejects(
      createAssignedRepositoryPullRequest(
        scheduleAuth,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, github },
      ),
      RepositoryPullRequestUnavailableError,
    );
    assert.equal(github.readHeadCalls, 0);
  });

  it("rejects a proposal returned from a different review job", async () => {
    const storedProposal = proposal();
    storedProposal.reviewJobId = "44444444-4444-4444-8444-444444444444";
    const store = new FakeArtifactStore(storedProposal);
    const github = new FakePullRequestCreator(BASE_SHA);

    await assert.rejects(
      createAssignedRepositoryPullRequest(
        scheduleAuth,
        { proposalDigest: PROPOSAL_DIGEST },
        { store, github },
      ),
      RepositoryPullRequestUnavailableError,
    );
    assert.equal(github.readHeadCalls, 0);
  });
});

class FakeArtifactStore implements RepositoryPullRequestArtifactStore {
  readonly recorded: Array<{
    proposal: RepositoryPullRequestProposal;
    idempotencyKey: string;
    branchName: string;
    commitSha: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }> = [];

  private readonly storedProposal: RepositoryPullRequestProposal | null;

  constructor(storedProposal: RepositoryPullRequestProposal | null) {
    this.storedProposal = storedProposal;
  }

  async loadProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<RepositoryPullRequestProposal | null> {
    return reviewJobId === REVIEW_JOB_ID &&
      proposalDigest === PROPOSAL_DIGEST
      ? this.storedProposal
      : null;
  }

  async findCreated(
    idempotencyKey: string,
  ) {
    const artifact = this.recorded.find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    return artifact
      ? {
          proposalDigest: artifact.proposal.digest,
          baseSha: artifact.proposal.baseSha,
          branchName: artifact.branchName,
          commitSha: artifact.commitSha,
          pullRequestNumber: artifact.pullRequestNumber,
          pullRequestUrl: artifact.pullRequestUrl,
        }
      : null;
  }

  async recordCreated(input: {
    proposal: RepositoryPullRequestProposal;
    idempotencyKey: string;
    branchName: string;
    commitSha: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    actorId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
  }) {
    const existing = await this.findCreated(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    this.recorded.push(input);
    return {
      proposalDigest: input.proposal.digest,
      baseSha: input.proposal.baseSha,
      branchName: input.branchName,
      commitSha: input.commitSha,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
    };
  }
}

class FakePullRequestCreator implements RepositoryPullRequestCreator {
  readonly createInputs: Array<{
    repositoryFullName: string;
    defaultBranch: string;
    baseSha: string;
    branchName: string;
    path: string;
    content: string;
    commitMessage: string;
    title: string;
    body: string;
    idempotencyKey: string;
  }> = [];
  readHeadCalls = 0;
  private readonly currentHead: string;
  private failFirstCreate: boolean;

  constructor(
    currentHead: string,
    failFirstCreate = false,
  ) {
    this.currentHead = currentHead;
    this.failFirstCreate = failFirstCreate;
  }

  async readDefaultBranchHead(): Promise<string> {
    this.readHeadCalls += 1;
    return this.currentHead;
  }

  async create(input: (typeof this.createInputs)[number]) {
    this.createInputs.push(input);
    if (this.failFirstCreate) {
      this.failFirstCreate = false;
      throw new Error("temporary GitHub failure");
    }
    return {
      commitSha: "d".repeat(40),
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.example/example/service/pull/17",
    };
  }
}

function proposal(): RepositoryPullRequestProposal {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    reviewJobId: REVIEW_JOB_ID,
    repositoryId: REPOSITORY_ID,
    repositoryFullName: "example/service",
    defaultBranch: "main",
    digest: PROPOSAL_DIGEST,
    baseSha: BASE_SHA,
    path: "docs/orders.md",
    content: "# Orders\n\nUse an idempotency key.\n",
  };
}
