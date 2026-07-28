import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfluenceClientConfig } from "./confluence-client-config.ts";

describe("loadConfluenceClientConfig", () => {
  it("loads read-only REST credentials and a bounded page size", () => {
    assert.deepEqual(
      loadConfluenceClientConfig({
        CONFLUENCE_API_TOKEN: "secret",
      }),
      {
        apiToken: "secret",
        maxPageBytes: 1_000_000,
      },
    );
  });

  it("rejects missing credentials and invalid limits", () => {
    assert.throws(() => loadConfluenceClientConfig({}));
    assert.throws(() =>
      loadConfluenceClientConfig({
        CONFLUENCE_API_TOKEN: "secret",
        CONFLUENCE_MAX_PAGE_BYTES: "0",
      }),
    );
    assert.throws(() =>
      loadConfluenceClientConfig({
        CONFLUENCE_API_TOKEN: "secret",
        CONFLUENCE_MAX_PAGE_BYTES: "1000001",
      }),
    );
  });
});
