import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfluencePageUpdateClient,
  ConfluencePageUpdateRequestError,
} from "./page-update-client.ts";

const CLOUD_ID = "123e4567-e89b-42d3-a456-426614174000";
const BASIC_AUTH = "Basic c2VydmljZUBleGFtcGxlLmNvbTpzZWNyZXQ=";

describe("ConfluencePageUpdateClient", () => {
  it("publishes the exact replacement and returns page and history URLs", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const client = new ConfluencePageUpdateClient({
      apiEmail: "service@example.com",
      apiToken: "secret",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(input).endsWith("/_edge/tenant_info")) {
          return Response.json({ cloudId: CLOUD_ID });
        }
        return Response.json({
          id: "12345",
          status: "current",
          version: { number: 8 },
          _links: { webui: "/spaces/ORD/pages/12345/Orders" },
        });
      },
    });

    const result = await client.updatePage({
      page: page(),
      bodyStorageValue: "<p>Updated</p>",
      auditMessage: "Approved documentation proposal.",
    });

    assert.deepEqual(result, {
      pageId: "12345",
      publishedVersion: 8,
      status: "published",
      pageUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/pages/12345/Orders",
      historyUrl:
        "https://example.atlassian.net/wiki/spaces/ORD/history/12345/Orders",
    });
    assert.deepEqual(requests.at(-1), {
      url:
        `https://api.atlassian.com/ex/confluence/${CLOUD_ID}` +
        "/wiki/api/v2/pages/12345",
      method: "PUT",
      authorization: BASIC_AUTH,
      body: {
        id: "12345",
        status: "current",
        title: "Orders",
        spaceId: "987",
        parentId: "456",
        body: { representation: "storage", value: "<p>Updated</p>" },
        version: { number: 8, message: "Approved documentation proposal." },
      },
    });
  });

  it("rejects unexpected responses and reports version conflicts", async () => {
    const wrongPage = new ConfluencePageUpdateClient({
      apiEmail: "service@example.com",
      apiToken: "secret",
      fetch: tenantThen(() =>
        Response.json({
          id: "99999",
          status: "current",
          version: { number: 8 },
          _links: { webui: "/spaces/ORD/pages/99999/Other" },
        }),
      ),
    });
    await assert.rejects(wrongPage.updatePage(request()), /expected page/);

    const conflict = new ConfluencePageUpdateClient({
      apiEmail: "service@example.com",
      apiToken: "secret",
      fetch: tenantThen(() => new Response(null, { status: 409 })),
    });
    await assert.rejects(
      conflict.updatePage(request()),
      (error: unknown) =>
        error instanceof ConfluencePageUpdateRequestError &&
        error.status === 409,
    );
  });
});

function request() {
  return {
    page: page(),
    bodyStorageValue: "<p>Updated</p>",
    auditMessage: "Approved documentation proposal.",
  };
}

function page() {
  return {
    siteId: "example.atlassian.net",
    pageId: "12345",
    version: 7,
    status: "current",
    title: "Orders",
    spaceId: "987",
    parentId: "456",
    bodyStorageValue: "<p>Current</p>",
    bodyHash: "d".repeat(64),
    fetchedAt: new Date("2026-07-29T12:00:00.000Z"),
  };
}

function tenantThen(next: () => Response): typeof fetch {
  return async (input) =>
    String(input).endsWith("/_edge/tenant_info")
      ? Response.json({ cloudId: CLOUD_ID })
      : next();
}
