import { getToken } from "@vercel/connect";
import { z } from "zod";

const CATALOG_PAGE_SIZE = 100;
const entityRefPattern =
  /^(?<kind>[a-z0-9_.-]+):(?<namespace>[a-z0-9_.-]+)\/(?<name>[a-z0-9_.-]+)$/i;

const roadieCatalogEntitySchema = z.object({
  apiVersion: z.string().min(1),
  kind: z.string().min(1),
  metadata: z.object({
    name: z.string().min(1),
    namespace: z.string().min(1).default("default"),
    etag: z.string().min(1).optional(),
    annotations: z
      .record(z.string(), z.string())
      .optional()
      .default({}),
    links: z
      .array(
        z.object({
          title: z.string().optional(),
          url: z.string().min(1),
          type: z.string().optional(),
        }),
      )
      .optional()
      .default([]),
  }),
  relations: z
    .array(
      z.object({
        type: z.string().min(1),
        targetRef: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
});

const roadieCatalogEntityListSchema = z.array(roadieCatalogEntitySchema);

/** Processed catalog entity returned by Roadie. */
export type RoadieCatalogEntity = z.infer<typeof roadieCatalogEntitySchema>;

/** Supplies a short-lived token for Roadie's catalog API. */
export type RoadieAccessTokenProvider = () => Promise<string>;

/** Dependencies for the read-only Roadie catalog client. */
export interface RoadieCatalogClientOptions {
  getAccessToken: RoadieAccessTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

/** Raised when Roadie returns a non-success response. */
export class RoadieCatalogRequestError extends Error {
  readonly requestPath: string;
  readonly status: number;

  constructor(requestPath: string, status: number) {
    super(`Roadie request ${requestPath} failed with status ${status}.`);
    this.name = "RoadieCatalogRequestError";
    this.requestPath = requestPath;
    this.status = status;
  }
}

/**
 * Read-only client for processed Roadie catalog entities.
 *
 * Responses are validated before reaching ownership and scope resolution.
 */
export class RoadieCatalogClient {
  private readonly getAccessToken: RoadieAccessTokenProvider;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: URL;

  constructor(options: RoadieCatalogClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
  }

  /**
   * Finds every Component candidate with the supplied metadata name.
   *
   * @returns All pages of processed Component entities.
   */
  async findComponentsByName(name: string): Promise<RoadieCatalogEntity[]> {
    if (!/^[a-z0-9_.-]+$/i.test(name)) {
      throw new Error(`Roadie Component name ${name} is invalid.`);
    }

    const requestUrl = new URL("entities", this.apiBaseUrl);
    requestUrl.searchParams.set(
      "filter",
      `kind=component,metadata.name=${name}`,
    );
    requestUrl.searchParams.set("limit", CATALOG_PAGE_SIZE.toString());
    const token = await this.readToken();
    const entities: RoadieCatalogEntity[] = [];
    let nextUrl: URL | undefined = requestUrl;

    while (nextUrl) {
      const response = await this.get(token, nextUrl);
      entities.push(
        ...roadieCatalogEntityListSchema.parse(await response.json()),
      );
      nextUrl = parseNextPage(response.headers.get("link"), this.apiBaseUrl);
    }
    return entities;
  }

  /**
   * Fetches one entity using a full `kind:namespace/name` reference.
   *
   * @returns The validated processed entity, or `null` when it is absent.
   */
  async getEntityByRef(
    entityRef: string,
  ): Promise<RoadieCatalogEntity | null> {
    const parsedRef = parseEntityRef(entityRef);
    const requestUrl = new URL(
      `entities/by-name/${encodeURIComponent(parsedRef.kind)}/` +
        `${encodeURIComponent(parsedRef.namespace)}/` +
        `${encodeURIComponent(parsedRef.name)}`,
      this.apiBaseUrl,
    );
    const response = await this.fetchResponse(
      await this.readToken(),
      requestUrl,
    );
    if (response.status === 404) {
      return null;
    }
    assertSuccessfulResponse(response, requestUrl);
    return roadieCatalogEntitySchema.parse(await response.json());
  }

  private async readToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (token.trim().length === 0) {
      throw new Error("Roadie access token provider returned an empty token.");
    }
    return token;
  }

  private async get(token: string, url: URL): Promise<Response> {
    const response = await this.fetchResponse(token, url);
    assertSuccessfulResponse(response, url);
    return response;
  }

  private async fetchResponse(token: string, url: URL): Promise<Response> {
    validateCatalogUrl(url, this.apiBaseUrl);
    return this.fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "documentation-drift-control-plane",
      },
    });
  }
}

/**
 * Creates an app-scoped Roadie token provider backed by Vercel Connect.
 *
 * @returns A provider suitable for `RoadieCatalogClient`.
 */
export function createRoadieAccessTokenProvider(
  connectorId: string,
): RoadieAccessTokenProvider {
  if (connectorId.trim().length === 0) {
    throw new Error("A Vercel Connect Roadie connector ID is required.");
  }
  return () => getToken(connectorId, { subject: { type: "app" } });
}

function validateApiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? "https://api.roadie.so/api/catalog/");
  if (url.protocol !== "https:" || !url.pathname.endsWith("/")) {
    throw new Error(
      "Roadie API base URL must use HTTPS and end with a slash.",
    );
  }
  return url;
}

function validateCatalogUrl(url: URL, apiBaseUrl: URL): void {
  if (
    url.origin !== apiBaseUrl.origin ||
    !url.pathname.startsWith(apiBaseUrl.pathname)
  ) {
    throw new Error("Roadie pagination URL escaped the catalog API boundary.");
  }
}

function assertSuccessfulResponse(response: Response, url: URL): void {
  if (!response.ok) {
    throw new RoadieCatalogRequestError(
      `${url.pathname}${url.search}`,
      response.status,
    );
  }
}

function parseNextPage(
  linkHeader: string | null,
  apiBaseUrl: URL,
): URL | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const link of linkHeader.split(",")) {
    const match = link.match(/^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i);
    if (match?.[1]) {
      const nextUrl = new URL(match[1], apiBaseUrl);
      validateCatalogUrl(nextUrl, apiBaseUrl);
      return nextUrl;
    }
  }
  return undefined;
}

/** Parses and canonicalizes a full Backstage entity reference. */
export function parseEntityRef(entityRef: string): {
  kind: string;
  namespace: string;
  name: string;
} {
  const match = entityRefPattern.exec(entityRef);
  if (!match?.groups) {
    throw new Error(
      `${entityRef} is not a full Roadie entity reference ` +
        "(kind:namespace/name).",
    );
  }
  return {
    kind: match.groups.kind!.toLowerCase(),
    namespace: match.groups.namespace!.toLowerCase(),
    name: match.groups.name!.toLowerCase(),
  };
}

/** Returns the canonical full reference for a processed entity. */
export function entityRef(entity: RoadieCatalogEntity): string {
  return (
    `${entity.kind}:${entity.metadata.namespace}/${entity.metadata.name}`
  ).toLowerCase();
}
