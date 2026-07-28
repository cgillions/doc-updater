import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RoadieScopeResolution } from "../../domain/documentation/documentation-scope.ts";
import { RepositoryRoadieScopeSynchronizer } from "./synchronize-roadie-scope.ts";

describe("RepositoryRoadieScopeSynchronizer", () => {
  it("resolves and persists the current registry identity", async () => {
    const resolution = resolvedScope();
    const calls: unknown[][] = [];
    const synchronizer = new RepositoryRoadieScopeSynchronizer(
      {
        async getResolutionTarget(repositoryId) {
          calls.push(["get", repositoryId]);
          return {
            id: repositoryId,
            repositoryFullName: "example/example-service",
          };
        },
        async applyResolution(
          repositoryId,
          repositoryFullName,
          result,
          refreshedAt,
        ) {
          calls.push([
            "apply",
            repositoryId,
            repositoryFullName,
            result,
            refreshedAt,
          ]);
        },
      },
      {
        async resolve(repositoryFullName) {
          calls.push(["resolve", repositoryFullName]);
          return resolution;
        },
      },
    );
    const refreshedAt = new Date("2026-07-28T10:00:00.000Z");

    const result = await synchronizer.synchronize(
      "11111111-1111-4111-8111-111111111111",
      refreshedAt,
    );

    assert.equal(result, resolution);
    assert.deepEqual(calls, [
      ["get", "11111111-1111-4111-8111-111111111111"],
      ["resolve", "example/example-service"],
      [
        "apply",
        "11111111-1111-4111-8111-111111111111",
        "example/example-service",
        resolution,
        refreshedAt,
      ],
    ]);
  });

  it("does not call Roadie when the registry entry does not exist", async () => {
    let resolverCalled = false;
    const synchronizer = new RepositoryRoadieScopeSynchronizer(
      {
        async getResolutionTarget() {
          return null;
        },
        async applyResolution() {
          throw new Error("Resolution must not be applied.");
        },
      },
      {
        async resolve() {
          resolverCalled = true;
          return resolvedScope();
        },
      },
    );

    await assert.rejects(
      synchronizer.synchronize(
        "22222222-2222-4222-8222-222222222222",
      ),
      /is not present in the repository registry/,
    );
    assert.equal(resolverCalled, false);
  });
});

function resolvedScope(): RoadieScopeResolution {
  return {
    status: "resolved",
    scope: {
      repositoryFullName: "example/example-service",
      componentRef: "component:default/example-service",
      systemRef: "system:default/example-system",
      ownerRef: "group:default/example-team",
      slackChannelId: "C0123456789",
      catalogRevision: "revision-1",
      configurationHash: "a".repeat(64),
      documents: [],
    },
    diagnostics: [],
  };
}
