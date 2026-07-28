import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { RoadieCatalogEntity } from "../../roadie/catalog-client.ts";
import { RoadieScopeResolver } from "./resolve-roadie-scope.ts";

const fixturePath = new URL(
  "../../../../test/fixtures/roadie-scope.json",
  import.meta.url,
);
describe("RoadieScopeResolver", () => {
  it("inherits Component, System, and Group documentation with local root exclusions", async () => {
    const catalog = catalogFixture();
    const result = await new RoadieScopeResolver(catalog).resolve(
      "example/example-service",
    );

    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") {
      return;
    }
    assert.deepEqual(catalog.componentQueries, ["example-service"]);
    assert.deepEqual(catalog.entityReads, [
      "system:default/example-system",
      "group:default/example-team",
    ]);
    assert.equal(result.scope.componentRef, "component:default/example-service");
    assert.equal(result.scope.systemRef, "system:default/example-system");
    assert.equal(result.scope.ownerRef, "group:default/example-team");
    assert.equal(result.scope.slackChannelId, "C0123456789");
    assert.equal(result.scope.catalogRevision, "component-revision-7");
    assert.match(result.scope.configurationHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      result.scope.documents.map((document) => ({
        siteId: document.siteId,
        pageId: document.pageId,
        declaration: document.declarations[0],
      })),
      [
        {
          siteId: "example.atlassian.net",
          pageId: "11111",
          declaration: {
            kind: "exact",
            excludedPageIds: [],
            provenance: {
              entityRef: "group:default/example-team",
              title: "Engineering handbook",
              url:
                "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/11111",
            },
          },
        },
        {
          siteId: "example.atlassian.net",
          pageId: "22222",
          declaration: {
            kind: "root",
            excludedPageIds: ["22229", "22230"],
            provenance: {
              entityRef: "group:default/example-team",
              title: "Team documentation",
              url:
                "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/22222",
            },
          },
        },
        {
          siteId: "example.atlassian.net",
          pageId: "33333",
          declaration: {
            kind: "exact",
            excludedPageIds: [],
            provenance: {
              entityRef: "system:default/example-system",
              title: "System architecture",
              url:
                "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/33333",
            },
          },
        },
        {
          siteId: "example.atlassian.net",
          pageId: "44444",
          declaration: {
            kind: "exact",
            excludedPageIds: [],
            provenance: {
              entityRef: "component:default/example-service",
              title: "Service runbook",
              url:
                "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/44444",
            },
          },
        },
      ],
    );
    assert.deepEqual(result.diagnostics, []);
  });

  it("de-duplicates canonical pages while retaining every provenance", async () => {
    const catalog = catalogFixture();
    catalog.entitiesByRef["system:default/example-system"]!.metadata.links.push({
      title: "Shared handbook",
      url:
        "https://example.atlassian.net/wiki/spaces/OTHER/pages/11111",
      type: "documentation-confluence-page",
    });

    const result = await new RoadieScopeResolver(catalog).resolve(
      "example/example-service",
    );

    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") {
      return;
    }
    const sharedPage = result.scope.documents.find(
      (document) => document.pageId === "11111",
    );
    assert.equal(sharedPage?.declarations.length, 2);
    assert.deepEqual(
      sharedPage?.declarations.map(
        (declaration) => declaration.provenance.entityRef,
      ),
      [
        "group:default/example-team",
        "system:default/example-system",
      ],
    );
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["DUPLICATE_DOCUMENTATION_LINK"],
    );
  });

  it("selects the one exact project-slug match from name candidates", async () => {
    const catalog = catalogFixture();
    const unrelated = structuredClone(catalog.components[0]!);
    unrelated.metadata.annotations["github.com/project-slug"] =
      "other/example-service";
    catalog.components.unshift(unrelated);

    const result = await new RoadieScopeResolver(catalog).resolve(
      "example/example-service",
    );

    assert.equal(result.status, "resolved");
  });

  for (const scenario of [
    {
      name: "missing Component",
      code: "COMPONENT_NOT_FOUND",
      mutate: (catalog: CatalogFixture) => {
        catalog.components = [];
      },
    },
    {
      name: "mismatched project slug",
      code: "COMPONENT_PROJECT_SLUG_MISMATCH",
      mutate: (catalog: CatalogFixture) => {
        catalog.components[0]!.metadata.annotations[
          "github.com/project-slug"
        ] = "other/example-service";
      },
    },
    {
      name: "duplicate verified Components",
      code: "COMPONENT_AMBIGUOUS",
      mutate: (catalog: CatalogFixture) => {
        catalog.components.push(structuredClone(catalog.components[0]!));
      },
    },
    {
      name: "missing System relation",
      code: "COMPONENT_SYSTEM_RELATION_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.components[0]!.relations = catalog.components[0]!.relations.filter(
          (relation) => relation.type !== "partOf",
        );
      },
    },
    {
      name: "ambiguous Component owner",
      code: "COMPONENT_OWNER_RELATION_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.components[0]!.relations.push({
          type: "ownedBy",
          targetRef: "group:default/other-team",
        });
      },
    },
    {
      name: "missing referenced System",
      code: "SYSTEM_NOT_FOUND",
      mutate: (catalog: CatalogFixture) => {
        delete catalog.entitiesByRef["system:default/example-system"];
      },
    },
    {
      name: "missing System owner",
      code: "SYSTEM_OWNER_RELATION_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.entitiesByRef[
          "system:default/example-system"
        ]!.relations = [];
      },
    },
    {
      name: "mismatched System ownership",
      code: "OWNERSHIP_MISMATCH",
      mutate: (catalog: CatalogFixture) => {
        catalog.entitiesByRef[
          "system:default/example-system"
        ]!.relations[0]!.targetRef = "group:default/other-team";
      },
    },
    {
      name: "missing referenced owner Group",
      code: "OWNER_NOT_FOUND",
      mutate: (catalog: CatalogFixture) => {
        delete catalog.entitiesByRef["group:default/example-team"];
      },
    },
    {
      name: "missing Slack route",
      code: "SLACK_ROUTE_MISSING",
      mutate: (catalog: CatalogFixture) => {
        delete catalog.entitiesByRef["group:default/example-team"]!.metadata
          .annotations["slack.com/channel-id"];
      },
    },
    {
      name: "invalid Slack route",
      code: "SLACK_ROUTE_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.entitiesByRef[
          "group:default/example-team"
        ]!.metadata.annotations["slack.com/channel-id"] =
          "#example-team";
      },
    },
    {
      name: "invalid root exclusions",
      code: "CONFLUENCE_EXCLUSIONS_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.entitiesByRef[
          "group:default/example-team"
        ]!.metadata.annotations[
          "docs.example.com/confluence-exclude-page-ids"
        ] = "22229,not-a-page";
      },
    },
    {
      name: "unapproved Confluence host",
      code: "CONFLUENCE_LINK_INVALID",
      mutate: (catalog: CatalogFixture) => {
        catalog.entitiesByRef[
          "group:default/example-team"
        ]!.metadata.links[0]!.url =
          "https://unapproved.example/wiki/spaces/EXAMPLE/pages/11111";
      },
    },
  ] as const) {
    it(`returns repo-only for ${scenario.name}`, async () => {
      const catalog = catalogFixture();
      scenario.mutate(catalog);

      const result = await new RoadieScopeResolver(catalog).resolve(
        "example/example-service",
      );

      assert.equal(result.status, "repo-only");
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        [scenario.code],
      );
    });
  }

  it("routes each repository through its resolved owner Group", async () => {
    const catalog = catalogFixture();
    catalog.entitiesByRef[
      "group:default/example-team"
    ]!.metadata.annotations["slack.com/channel-id"] =
      "C9876543210";

    const result = await new RoadieScopeResolver(catalog).resolve(
      "example/example-service",
    );

    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.scope.slackChannelId, "C9876543210");
    }
  });

  it("aborts refreshes on transient catalog failures", async () => {
    const catalog = catalogFixture();
    catalog.getEntityByRef = async () => {
      throw new Error("Roadie is unavailable.");
    };

    await assert.rejects(
      new RoadieScopeResolver(catalog).resolve(
        "example/example-service",
      ),
      /Roadie is unavailable/,
    );
  });

  it("derives Confluence identity from a Roadie homepage link", async () => {
    const catalog = catalogFixture();
    catalog.entitiesByRef[
      "group:default/example-team"
    ]!.metadata.links = [
      {
        title: "Team homepage",
        url:
          "https://craftd-art.atlassian.net/wiki/spaces/DU/overview?homepageId=491629",
        type: "documentation-confluence-page",
      },
    ];

    const result = await new RoadieScopeResolver(catalog).resolve(
      "example/example-service",
    );

    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.deepEqual(
        result.scope.documents.find(
          ({ pageId }) => pageId === "491629",
        ),
        {
          siteId: "craftd-art.atlassian.net",
          pageId: "491629",
          declarations: [
            {
              kind: "exact",
              excludedPageIds: [],
              provenance: {
                entityRef: "group:default/example-team",
                title: "Team homepage",
                url:
                  "https://craftd-art.atlassian.net/wiki/spaces/DU/overview?homepageId=491629",
              },
            },
          ],
        },
      );
    }
  });
});

interface CatalogFixture {
  components: RoadieCatalogEntity[];
  entitiesByRef: Record<string, RoadieCatalogEntity>;
  componentQueries: string[];
  entityReads: string[];
  findComponentsByName(name: string): Promise<RoadieCatalogEntity[]>;
  getEntityByRef(entityRef: string): Promise<RoadieCatalogEntity | null>;
}

function catalogFixture(): CatalogFixture {
  const data = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as Pick<CatalogFixture, "components" | "entitiesByRef">;
  return {
    ...data,
    componentQueries: [],
    entityReads: [],
    async findComponentsByName(name) {
      this.componentQueries.push(name);
      return this.components;
    },
    async getEntityByRef(entityRef) {
      this.entityReads.push(entityRef);
      const entity = this.entitiesByRef[entityRef];
      if (!entity) {
        return null;
      }
      return entity;
    },
  };
}
