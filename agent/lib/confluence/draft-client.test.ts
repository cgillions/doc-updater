import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfluenceDraftClient,
  ConfluenceDraftRequestError,
} from "./draft-client.ts";

const CLOUD_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("ConfluenceDraftClient", () => {
  it("updates only the existing page as an unpublished native-storage draft", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const client = new ConfluenceDraftClient({
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
          status: "draft",
          version: { number: 8 },
        });
      },
    });

    const result = await client.createDraft({
      page: page(),
      bodyStorageValue:
        '<h2>Orders</h2><p>Updated</p><ac:structured-macro ac:name="code" />',
      auditMessage: "Documentation proposal digest for review job.",
    });

    assert.deepEqual(result, {
      draftPageId: "12345",
      draftVersion: 8,
      status: "draft",
    });
    assert.deepEqual(requests, [
      {
        url: "https://example.atlassian.net/_edge/tenant_info",
        method: "GET",
        authorization: null,
        body: undefined,
      },
      {
        url:
          `https://api.atlassian.com/ex/confluence/${CLOUD_ID}` +
          "/wiki/api/v2/pages/12345",
        method: "PUT",
        authorization: "Bearer secret",
        body: {
          id: "12345",
          status: "draft",
          title: "Orders",
          spaceId: "987",
          parentId: "456",
          body: {
            representation: "storage",
            value:
              '<h2>Orders</h2><p>Updated</p><ac:structured-macro ac:name="code" />',
          },
          version: {
            number: 8,
            message: "Documentation proposal digest for review job.",
          },
        },
      },
    ]);
  });

  it("rejects a non-draft response and reports version conflicts", async () => {
    const nonDraft = new ConfluenceDraftClient({
      apiToken: "secret",
      fetch: tenantThen(() =>
        Response.json({
          id: "12345",
          status: "current",
          version: { number: 8 },
        }),
      ),
    });
    await assert.rejects(
      nonDraft.createDraft(request()),
      /unpublished draft/,
    );

    const conflict = new ConfluenceDraftClient({
      apiToken: "secret",
      fetch: tenantThen(() => new Response(null, { status: 409 })),
    });
    await assert.rejects(
      conflict.createDraft(request()),
      (error: unknown) =>
        error instanceof ConfluenceDraftRequestError && error.status === 409,
    );
  });
});

function request() {
  return {
    page: page(),
    bodyStorageValue: "<p>Updated</p>",
    auditMessage: "Documentation proposal digest for review job.",
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
