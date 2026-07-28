/** Machine-readable reasons why Roadie scope resolution could not be trusted. */
export type RoadieScopeDiagnosticCode =
  | "COMPONENT_NOT_FOUND"
  | "COMPONENT_PROJECT_SLUG_MISMATCH"
  | "COMPONENT_AMBIGUOUS"
  | "COMPONENT_SYSTEM_RELATION_INVALID"
  | "COMPONENT_OWNER_RELATION_INVALID"
  | "SYSTEM_NOT_FOUND"
  | "SYSTEM_OWNER_RELATION_INVALID"
  | "OWNERSHIP_MISMATCH"
  | "OWNER_NOT_FOUND"
  | "SLACK_ROUTE_MISSING"
  | "SLACK_ROUTE_INVALID"
  | "CONFLUENCE_EXCLUSIONS_INVALID"
  | "CONFLUENCE_LINK_INVALID"
  | "DUPLICATE_DOCUMENTATION_LINK";

/** Resolution warning or blocking diagnostic suitable for persistence. */
export interface RoadieScopeDiagnostic {
  code: RoadieScopeDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  entityRef?: string;
}

/** Catalog declaration that made a Confluence page eligible. */
export interface DocumentationDeclaration {
  kind: "exact" | "root";
  excludedPageIds: string[];
  provenance: {
    entityRef: string;
    title?: string;
    url: string;
  };
}

/** Canonical Confluence target, de-duplicated by site and page identity. */
export interface DocumentationTarget {
  siteId: string;
  pageId: string;
  declarations: DocumentationDeclaration[];
}

/** Trusted routing and documentation metadata for one repository. */
export interface ResolvedDocumentationScope {
  repositoryFullName: string;
  componentRef: string;
  systemRef: string;
  ownerRef: string;
  slackChannelId: string;
  catalogRevision: string | null;
  configurationHash: string;
  documents: DocumentationTarget[];
}

/** Fail-closed result of resolving one repository through Roadie. */
export type RoadieScopeResolution =
  | {
      status: "resolved";
      scope: ResolvedDocumentationScope;
      diagnostics: RoadieScopeDiagnostic[];
    }
  | {
      status: "repo-only";
      diagnostics: RoadieScopeDiagnostic[];
    };
