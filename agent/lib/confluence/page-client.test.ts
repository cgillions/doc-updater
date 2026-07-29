import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  ConfluencePageClient,
  ConfluencePageRequestError,
} from "./page-client.ts";

const STORAGE =
  '<h1>Orders</h1><p>Use <ac:structured-macro ac:name="code" /></p>';
const CLOUD_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("ConfluencePageClient", () => {
  it("reads and hashes native storage content at an exact page identity", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("authorization"),
        });
        if (String(input).endsWith("/_edge/tenant_info")) {
          return Response.json({ cloudId: CLOUD_ID });
        }
        return Response.json({
          id: "12345",
          status: "current",
          title: "Orders",
          spaceId: "987",
          parentId: "456",
          version: { number: 7 },
          body: {
            storage: {
              representation: "storage",
              value: STORAGE,
            },
          },
        });
      },
    });
    const fetchedAt = new Date("2026-07-28T12:00:00.000Z");

    const page = await client.getPage(
      { siteId: "example.atlassian.net", pageId: "12345" },
      fetchedAt,
    );

    assert.deepEqual(page, {
      siteId: "example.atlassian.net",
      pageId: "12345",
      version: 7,
      status: "current",
      title: "Orders",
      spaceId: "987",
      parentId: "456",
      bodyStorageValue: STORAGE,
      bodyHash: createHash("sha256").update(STORAGE).digest("hex"),
      fetchedAt,
    });
    assert.deepEqual(requests, [
      {
        url:
          "https://example.atlassian.net/_edge/tenant_info",
        authorization: null,
      },
      {
        url:
          `https://api.atlassian.com/ex/confluence/${CLOUD_ID}` +
          "/wiki/api/v2/pages/12345?body-format=storage",
        authorization: "Bearer secret",
      },
    ]);
  });

  it("fails closed for restricted pages and invalid response identities", async () => {
    let restrictedRequests = 0;
    const restricted = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async () => {
        restrictedRequests += 1;
        return restrictedRequests === 1
          ? Response.json({ cloudId: CLOUD_ID })
          : new Response(null, { status: 404 });
      },
    });
    await assert.rejects(
      restricted.getPage({
        siteId: "example.atlassian.net",
        pageId: "12345",
      }),
      (error: unknown) =>
        error instanceof ConfluencePageRequestError &&
        error.status === 404,
    );

    let mismatchedRequests = 0;
    const mismatched = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async () => {
        mismatchedRequests += 1;
        return mismatchedRequests === 1
          ? Response.json({ cloudId: CLOUD_ID })
          : Response.json({
          id: "99999",
          status: "current",
          title: "Wrong page",
          spaceId: "987",
          version: { number: 1 },
          body: {
            storage: {
              representation: "storage",
              value: "<p>Wrong</p>",
            },
          },
        });
      },
    });
    await assert.rejects(
      mismatched.getPage({
        siteId: "example.atlassian.net",
        pageId: "12345",
      }),
      /unexpected page identity/,
    );
  });

  it("uses Confluence draft metadata as the source of truth without reading a body", async () => {
    const requests: string[] = [];
    const client = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async (input) => {
        requests.push(String(input));
        if (String(input).endsWith("/_edge/tenant_info")) {
          return Response.json({ cloudId: CLOUD_ID });
        }
        return Response.json({
          id: "12345",
          status: "draft",
          version: { number: 8 },
        });
      },
    });

    const draft = await client.getDraftState({
      siteId: "example.atlassian.net",
      pageId: "12345",
    });

    assert.deepEqual(draft, { pageId: "12345", version: 8 });
    assert.deepEqual(requests, [
      "https://example.atlassian.net/_edge/tenant_info",
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}` +
        "/wiki/api/v2/pages/12345?get-draft=true",
    ]);
  });

  it("reports no draft only when Confluence returns the current page", async () => {
    let requests = 0;
    const client = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ cloudId: CLOUD_ID })
          : Response.json({
              id: "12345",
              status: "current",
              version: { number: 7 },
            });
      },
    });

    assert.equal(
      await client.getDraftState({
        siteId: "example.atlassian.net",
        pageId: "12345",
      }),
      null,
    );
  });

  it("resolves each trusted site cloud ID once", async () => {
    let tenantRequests = 0;
    const client = new ConfluencePageClient({
      apiToken: "secret",
      fetch: async (input) => {
        if (String(input).endsWith("/_edge/tenant_info")) {
          tenantRequests += 1;
          return Response.json({ cloudId: CLOUD_ID });
        }
        const pageId = new URL(String(input)).pathname.split("/").at(-1);
        return Response.json({
          id: pageId,
          status: "current",
          title: "Page",
          spaceId: "987",
          version: { number: 1 },
          body: {
            storage: {
              representation: "storage",
              value: "<p>Page</p>",
            },
          },
        });
      },
    });

    await client.getPage({
      siteId: "example.atlassian.net",
      pageId: "12345",
    });
    await client.getPage({
      siteId: "example.atlassian.net",
      pageId: "67890",
    });

    assert.equal(tenantRequests, 1);
  });
});
