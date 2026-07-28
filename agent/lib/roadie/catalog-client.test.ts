import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RoadieCatalogClient,
  RoadieCatalogRequestError,
} from "./catalog-client.ts";

describe("RoadieCatalogClient", () => {
  it("queries components by repository name and follows catalog pagination", async () => {
    const requests: Array<{ authorization: string | null; path: string }> = [];
    const client = new RoadieCatalogClient({
      getAccessToken: async () => "roadie-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/api/catalog/entities?filter=kind%3Dcomponent%2Cmetadata.name%3Dexample-service&limit=100",
            jsonResponse(
              [componentFixture("example-service-a")],
              200,
              {
                Link: '</api/catalog/entities?cursor=next-page>; rel="next"',
              },
            ),
          ],
          [
            "/api/catalog/entities?cursor=next-page",
            jsonResponse([componentFixture("example-service-b")]),
          ],
        ]),
        requests,
      ),
    });

    const components = await client.findComponentsByName("example-service");

    assert.deepEqual(
      components.map((component) => component.metadata.name),
      ["example-service-a", "example-service-b"],
    );
    assert.deepEqual(requests, [
      {
        authorization: "Bearer roadie-token",
        path:
          "/api/catalog/entities?filter=kind%3Dcomponent%2Cmetadata.name%3Dexample-service&limit=100",
      },
      {
        authorization: "Bearer roadie-token",
        path: "/api/catalog/entities?cursor=next-page",
      },
    ]);
  });

  it("fetches a processed entity by its full entity reference", async () => {
    const client = new RoadieCatalogClient({
      getAccessToken: async () => "roadie-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/api/catalog/entities/by-name/system/default/example-system",
            jsonResponse(systemFixture()),
          ],
        ]),
      ),
    });

    const system = await client.getEntityByRef(
      "system:default/example-system",
    );

    assert.equal(system.kind, "System");
    assert.deepEqual(system.relations, [
      { type: "ownedBy", targetRef: "group:default/example-team" },
    ]);
  });

  it("rejects relative entity references before making a request", async () => {
    let requested = false;
    const client = new RoadieCatalogClient({
      getAccessToken: async () => "roadie-token",
      fetch: async () => {
        requested = true;
        return jsonResponse({});
      },
    });

    await assert.rejects(
      client.getEntityByRef("example-system"),
      /full Roadie entity reference/,
    );
    assert.equal(requested, false);
  });

  it("reports failed Roadie requests without returning partial data", async () => {
    const client = new RoadieCatalogClient({
      getAccessToken: async () => "roadie-token",
      fetch: createFixtureFetch(
        new Map([
          [
            "/api/catalog/entities?filter=kind%3Dcomponent%2Cmetadata.name%3Dexample-service&limit=100",
            jsonResponse({ error: "Unavailable" }, 503),
          ],
        ]),
      ),
    });

    await assert.rejects(
      client.findComponentsByName("example-service"),
      (error: unknown) =>
        error instanceof RoadieCatalogRequestError &&
        error.status === 503 &&
        error.requestPath.includes("metadata.name%3Dexample-service"),
    );
  });
});

function componentFixture(name: string): object {
  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Component",
    metadata: {
      name,
      namespace: "default",
      etag: "catalog-revision",
      annotations: {
        "github.com/project-slug": `example/${name}`,
      },
      links: [],
    },
    relations: [
      { type: "partOf", targetRef: "system:default/example-system" },
      { type: "ownedBy", targetRef: "group:default/example-team" },
    ],
  };
}

function systemFixture(): object {
  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "System",
    metadata: {
      name: "example-system",
      namespace: "default",
    },
    relations: [
      { type: "ownedBy", targetRef: "group:default/example-team" },
    ],
  };
}

function jsonResponse(
  body: object,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createFixtureFetch(
  fixtures: Map<string, Response>,
  requests: Array<{ authorization: string | null; path: string }> = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const path = `${url.pathname}${url.search}`;
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      path,
    });
    return (
      fixtures.get(path)?.clone() ??
      jsonResponse({ error: `No fixture for ${path}` }, 404)
    );
  };
}
