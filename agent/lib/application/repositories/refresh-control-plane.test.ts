import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ScheduledControlPlaneRefresher,
  type RoadieRefreshCandidate,
} from "./refresh-control-plane.ts";
import { setLoggerForTesting } from "../../observability/logger.ts";

const NOW = new Date("2026-07-29T07:00:00.000Z");

describe("ScheduledControlPlaneRefresher", () => {
  beforeEach(() => {
    setLoggerForTesting({
      debug() {},
      info() {},
      warn() {},
      error() {},
    });
  });

  afterEach(() => {
    setLoggerForTesting(undefined);
  });

  it("aborts before Roadie selection when the complete inventory fails", async () => {
    let candidatesLoaded = false;
    const refresher = new ScheduledControlPlaneRefresher({
      inventory: {
        async synchronize() {
          throw new Error("GitHub inventory is incomplete.");
        },
      },
      candidates: {
        async listRoadieRefreshCandidates() {
          candidatesLoaded = true;
          return [];
        },
      },
      roadie: {
        async synchronize() {
          throw new Error("Roadie must not be called.");
        },
      },
      config: {
        roadieRefreshLimit: 10,
        roadieRefreshIntervalMs: 86_400_000,
      },
    });

    await assert.rejects(
      refresher.refresh(NOW),
      /GitHub inventory is incomplete/,
    );
    assert.equal(candidatesLoaded, false);
  });

  it("bounds Roadie refresh and isolates one repository failure", async () => {
    const candidates: RoadieRefreshCandidate[] = [
      { repositoryId: "repository-1" },
      { repositoryId: "repository-2" },
      { repositoryId: "repository-3" },
    ];
    const synchronized: string[] = [];
    const refresher = new ScheduledControlPlaneRefresher({
      inventory: {
        async synchronize(refreshedAt) {
          assert.equal(refreshedAt, NOW);
          return {
            accessibleRepositoryCount: 3,
            inaccessibleRepositoryCount: 1,
          };
        },
      },
      candidates: {
        async listRoadieRefreshCandidates(input) {
          assert.deepEqual(input, {
            limit: 2,
            staleBefore: new Date("2026-07-28T07:00:00.000Z"),
          });
          return candidates;
        },
      },
      roadie: {
        async synchronize(repositoryId, refreshedAt) {
          assert.equal(refreshedAt, NOW);
          synchronized.push(repositoryId);
          if (repositoryId === "repository-2") {
            throw new Error("Roadie unavailable.");
          }
        },
      },
      config: {
        roadieRefreshLimit: 2,
        roadieRefreshIntervalMs: 86_400_000,
      },
    });

    const result = await refresher.refresh(NOW);

    assert.deepEqual(synchronized, ["repository-1", "repository-2"]);
    assert.deepEqual(result, {
      accessibleRepositoryCount: 3,
      inaccessibleRepositoryCount: 1,
      roadieCandidateCount: 2,
      roadieRefreshedCount: 1,
      roadieFailedRepositoryIds: ["repository-2"],
    });
  });
});
