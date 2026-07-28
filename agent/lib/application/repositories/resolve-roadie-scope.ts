import { createHash } from "node:crypto";

import type {
  DocumentationDeclaration,
  DocumentationTarget,
  RoadieScopeDiagnostic,
  RoadieScopeDiagnosticCode,
  RoadieScopeResolution,
} from "../../domain/documentation/documentation-scope.ts";
import {
  entityRef,
  parseEntityRef,
  type RoadieCatalogEntity,
} from "../../roadie/catalog-client.ts";

const PROJECT_SLUG_ANNOTATION = "github.com/project-slug";
const SLACK_CHANNEL_ANNOTATION = "slack.com/channel-id";
const CONFLUENCE_EXCLUSIONS_ANNOTATION_SUFFIX =
  "/confluence-exclude-page-ids";
const EXACT_LINK_TYPE = "documentation-confluence-page";
const ROOT_LINK_TYPE = "documentation-confluence-root";

/** Read operations required from the processed Roadie catalog. */
export interface RoadieScopeCatalog {
  findComponentsByName(name: string): Promise<RoadieCatalogEntity[]>;
  getEntityByRef(
    entityRef: string,
  ): Promise<RoadieCatalogEntity | null>;
}

/**
 * Resolves trusted ownership, Slack routing, and documentation scope.
 *
 * Any ambiguous or invalid required metadata returns `repo-only`; the resolver
 * never guesses a catalog identity or route.
 */
export class RoadieScopeResolver {
  private readonly catalog: RoadieScopeCatalog;

  constructor(catalog: RoadieScopeCatalog) {
    this.catalog = catalog;
  }

  /**
   * Resolves one GitHub `owner/name` repository.
   *
   * @returns A trusted scope, or typed diagnostics and `repo-only` state.
   */
  async resolve(repositoryFullName: string): Promise<RoadieScopeResolution> {
    const repositoryName = repositoryFullName.split("/")[1];
    if (!repositoryName || !/^[^/]+\/[^/]+$/.test(repositoryFullName)) {
      return repoOnly(
        "COMPONENT_NOT_FOUND",
        `Repository name ${repositoryFullName} is invalid.`,
      );
    }

    const candidates =
      await this.catalog.findComponentsByName(repositoryName);
    if (candidates.length === 0) {
      return repoOnly(
        "COMPONENT_NOT_FOUND",
        `No Roadie Component named ${repositoryName} was found.`,
      );
    }
    const matches = candidates.filter(
      (candidate) =>
        candidate.kind.toLowerCase() === "component" &&
        candidate.metadata.name.toLowerCase() ===
          repositoryName.toLowerCase() &&
        candidate.metadata.annotations[PROJECT_SLUG_ANNOTATION]?.toLowerCase() ===
        repositoryFullName.toLowerCase(),
    );
    if (matches.length === 0) {
      return repoOnly(
        "COMPONENT_PROJECT_SLUG_MISMATCH",
        `No Component named ${repositoryName} declares ${repositoryFullName}.`,
      );
    }
    if (matches.length > 1) {
      return repoOnly(
        "COMPONENT_AMBIGUOUS",
        `${matches.length} Components declare ${repositoryFullName}.`,
      );
    }

    const component = matches[0]!;
    const componentRef = entityRef(component);
    const systemRelation = singleRelation(component, "partOf", "system");
    if (!systemRelation) {
      return repoOnly(
        "COMPONENT_SYSTEM_RELATION_INVALID",
        `${componentRef} must have exactly one processed System partOf relation.`,
        componentRef,
      );
    }
    const componentOwner = singleRelation(component, "ownedBy", "group");
    if (!componentOwner) {
      return repoOnly(
        "COMPONENT_OWNER_RELATION_INVALID",
        `${componentRef} must have exactly one processed Group ownedBy relation.`,
        componentRef,
      );
    }

    const systemResult = await this.readReferencedEntity(
      systemRelation,
      "system",
      "SYSTEM_NOT_FOUND",
    );
    if ("diagnostic" in systemResult) {
      return { status: "repo-only", diagnostics: [systemResult.diagnostic] };
    }
    const system = systemResult.entity;
    const systemRef = entityRef(system);
    const systemOwner = singleRelation(system, "ownedBy", "group");
    if (!systemOwner) {
      return repoOnly(
        "SYSTEM_OWNER_RELATION_INVALID",
        `${systemRef} must have exactly one processed Group ownedBy relation.`,
        systemRef,
      );
    }
    if (systemOwner !== componentOwner) {
      return repoOnly(
        "OWNERSHIP_MISMATCH",
        `${componentRef} and ${systemRef} resolve to different owners.`,
        componentRef,
      );
    }

    const ownerResult = await this.readReferencedEntity(
      componentOwner,
      "group",
      "OWNER_NOT_FOUND",
    );
    if ("diagnostic" in ownerResult) {
      return { status: "repo-only", diagnostics: [ownerResult.diagnostic] };
    }
    const owner = ownerResult.entity;
    const ownerRef = entityRef(owner);
    const slackChannelId =
      owner.metadata.annotations[SLACK_CHANNEL_ANNOTATION];
    if (!slackChannelId) {
      return repoOnly(
        "SLACK_ROUTE_MISSING",
        `${ownerRef} does not declare a Slack channel.`,
        ownerRef,
      );
    }
    if (!/^[CG][A-Z0-9]{8,}$/.test(slackChannelId)) {
      return repoOnly(
        "SLACK_ROUTE_INVALID",
        `${ownerRef} declares an invalid Slack channel ID.`,
        ownerRef,
      );
    }

    const documentation = this.collectDocumentation([
      component,
      system,
      owner,
    ]);
    if ("diagnostic" in documentation) {
      return { status: "repo-only", diagnostics: [documentation.diagnostic] };
    }

    const scopeWithoutHash = {
      repositoryFullName,
      componentRef,
      systemRef,
      ownerRef,
      slackChannelId,
      catalogRevision: component.metadata.etag ?? null,
      documents: documentation.documents,
    };
    return {
      status: "resolved",
      scope: {
        ...scopeWithoutHash,
        configurationHash: hashConfiguration(scopeWithoutHash),
      },
      diagnostics: documentation.diagnostics,
    };
  }

  private async readReferencedEntity(
    targetRef: string,
    expectedKind: string,
    diagnosticCode: "SYSTEM_NOT_FOUND" | "OWNER_NOT_FOUND",
  ): Promise<
    | { entity: RoadieCatalogEntity }
    | { diagnostic: RoadieScopeDiagnostic }
  > {
    const entity = await this.catalog.getEntityByRef(targetRef);
    if (
      !entity ||
      entityRef(entity) !== targetRef ||
      entity.kind.toLowerCase() !== expectedKind
    ) {
      return {
        diagnostic: diagnostic(
          diagnosticCode,
          `Roadie could not resolve ${targetRef} as a ${expectedKind}.`,
          "error",
          targetRef,
        ),
      };
    }
    return { entity };
  }

  private collectDocumentation(
    entities: RoadieCatalogEntity[],
  ):
    | {
        documents: DocumentationTarget[];
        diagnostics: RoadieScopeDiagnostic[];
      }
    | { diagnostic: RoadieScopeDiagnostic } {
    const documents = new Map<string, DocumentationTarget>();
    const duplicateKeys = new Set<string>();

    for (const entity of entities) {
      const sourceRef = entityRef(entity);
      const exclusionsResult = readConfluenceExclusions(
        entity.metadata.annotations,
      );
      if ("error" in exclusionsResult) {
        return {
          diagnostic: diagnostic(
            "CONFLUENCE_EXCLUSIONS_INVALID",
            `${sourceRef} declares invalid Confluence page exclusions.`,
            "error",
            sourceRef,
          ),
        };
      }

      for (const link of entity.metadata.links) {
        const kind = linkKind(link.type);
        if (!kind) {
          continue;
        }
        const target = this.parseConfluenceTarget(link.url);
        if (!target) {
          return {
            diagnostic: diagnostic(
              "CONFLUENCE_LINK_INVALID",
              `${sourceRef} declares an invalid or unapproved Confluence link.`,
              "error",
              sourceRef,
            ),
          };
        }
        const declaration: DocumentationDeclaration = {
          kind,
          excludedPageIds:
            kind === "root" ? exclusionsResult.pageIds : [],
          provenance: {
            entityRef: sourceRef,
            ...(link.title ? { title: link.title } : {}),
            url: link.url,
          },
        };
        const key = `${target.siteId}:${target.pageId}`;
        const existing = documents.get(key);
        if (existing) {
          existing.declarations.push(declaration);
          duplicateKeys.add(key);
        } else {
          documents.set(key, {
            ...target,
            declarations: [declaration],
          });
        }
      }
    }

    const canonicalDocuments = [...documents.values()]
      .sort(compareTargets)
      .map((target) => ({
        ...target,
        declarations: target.declarations.sort((left, right) =>
          left.provenance.entityRef.localeCompare(
            right.provenance.entityRef,
          ),
        ),
      }));
    return {
      documents: canonicalDocuments,
      diagnostics: [...duplicateKeys]
        .sort()
        .map((key) =>
          diagnostic(
            "DUPLICATE_DOCUMENTATION_LINK",
            `Confluence target ${key} is declared more than once.`,
            "warning",
          ),
        ),
    };
  }

  private parseConfluenceTarget(
    value: string,
  ): { siteId: string; pageId: string } | undefined {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    const siteId = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !isConfluenceCloudHostname(siteId)
    ) {
      return undefined;
    }
    const pathMatch = url.pathname.match(
      /^\/wiki\/spaces\/[^/]+\/pages\/(?<pageId>\d+)(?:\/|$)/,
    );
    const queryPageId =
      url.pathname === "/wiki/pages/viewpage.action"
        ? url.searchParams.get("pageId")
        : undefined;
    const homepageId =
      /^\/wiki\/spaces\/[^/]+\/overview\/?$/.test(url.pathname)
        ? url.searchParams.get("homepageId")
        : undefined;
    const pageId =
      pathMatch?.groups?.pageId ?? queryPageId ?? homepageId;
    if (!pageId || !/^\d+$/.test(pageId)) {
      return undefined;
    }
    return { siteId, pageId };
  }
}

function singleRelation(
  entity: RoadieCatalogEntity,
  relationType: string,
  targetKind: string,
): string | undefined {
  const relations = entity.relations.filter(
    (relation) =>
      relation.type.toLowerCase() === relationType.toLowerCase(),
  );
  if (relations.length !== 1) {
    return undefined;
  }
  try {
    const parsed = parseEntityRef(relations[0]!.targetRef);
    return parsed.kind === targetKind
      ? `${parsed.kind}:${parsed.namespace}/${parsed.name}`
      : undefined;
  } catch {
    return undefined;
  }
}

function linkKind(
  type: string | undefined,
): DocumentationDeclaration["kind"] | undefined {
  if (type === EXACT_LINK_TYPE) {
    return "exact";
  }
  if (type === ROOT_LINK_TYPE) {
    return "root";
  }
  return undefined;
}

function parseExclusions(
  value: string | undefined,
): { pageIds: string[] } | { error: true } {
  if (!value?.trim()) {
    return { pageIds: [] };
  }
  const pageIds = [...new Set(value.split(",").map((item) => item.trim()))];
  if (pageIds.some((pageId) => !/^\d+$/.test(pageId))) {
    return { error: true };
  }
  return { pageIds: pageIds.sort() };
}

function readConfluenceExclusions(
  annotations: Record<string, string>,
): { pageIds: string[] } | { error: true } {
  const values = Object.entries(annotations)
    .filter(([key]) =>
      key.endsWith(CONFLUENCE_EXCLUSIONS_ANNOTATION_SUFFIX),
    )
    .map(([, value]) => value);
  if (values.length > 1) {
    return { error: true };
  }
  return parseExclusions(values[0]);
}

function isConfluenceCloudHostname(hostname: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(
      hostname,
    )
  );
}

function compareTargets(
  left: DocumentationTarget,
  right: DocumentationTarget,
): number {
  return (
    left.siteId.localeCompare(right.siteId) ||
    left.pageId.localeCompare(right.pageId, undefined, { numeric: true })
  );
}

function hashConfiguration(value: object): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function repoOnly(
  code: RoadieScopeDiagnosticCode,
  message: string,
  sourceRef?: string,
): RoadieScopeResolution {
  return {
    status: "repo-only",
    diagnostics: [diagnostic(code, message, "error", sourceRef)],
  };
}

function diagnostic(
  code: RoadieScopeDiagnosticCode,
  message: string,
  severity: "error" | "warning",
  sourceRef?: string,
): RoadieScopeDiagnostic {
  return {
    code,
    severity,
    message,
    ...(sourceRef ? { entityRef: sourceRef } : {}),
  };
}
