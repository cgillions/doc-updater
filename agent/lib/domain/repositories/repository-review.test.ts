import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repositoryFileReadResultSchema } from "./repository-review.ts";

describe("repository review file read result", () => {
  it("accepts a controlled not-found result for safe assigned-path misses", () => {
    assert.deepEqual(
      repositoryFileReadResultSchema.parse({
        status: "not-found",
        path: "agent/tools/publish-confluence-page-update.ts",
        revision: "head",
        guidance: "Search for the exact returned path before retrying.",
      }),
      {
        status: "not-found",
        path: "agent/tools/publish-confluence-page-update.ts",
        revision: "head",
        guidance: "Search for the exact returned path before retrying.",
      },
    );
  });
});
