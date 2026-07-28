import { z } from "zod";

import {
  hashConfluenceBody,
  type ConfluencePage,
  type ConfluencePageTarget,
} from "../domain/documentation/confluence-page.ts";

const pageSchema = z.object({
  id: z.string().regex(/^\d+$/),
  status: z.string().min(1),
  title: z.string(),
  spaceId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  version: z.object({
    number: z.number().int().positive(),
  }),
  body: z.object({
    storage: z.object({
      representation: z.literal("storage"),
      value: z.string(),
    }),
  }),
});

const tenantSchema = z.object({
  cloudId: z.uuid(),
});

export interface ConfluencePageClientOptions {
  apiToken: string;
  fetch?: typeof fetch;
  maxPageBytes?: number;
}

export class ConfluencePageRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 404
        ? "The Confluence page is unavailable or the credential cannot view it."
        : `The Confluence page request failed with status ${status}.`,
    );
    this.name = "ConfluencePageRequestError";
    this.status = status;
  }
}

/** Reads exact Confluence Cloud pages without exposing credentials or search. */
export class ConfluencePageClient {
  private readonly authorization: string;
  private readonly cloudIds = new Map<string, Promise<string>>();
  private readonly fetch: typeof fetch;
  private readonly maxPageBytes: number;

  constructor(options: ConfluencePageClientOptions) {
    if (!options.apiToken.trim()) {
      throw new Error("A Confluence API token is required.");
    }
    this.authorization = `Bearer ${options.apiToken}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxPageBytes = options.maxPageBytes ?? 1_000_000;
    if (
      !Number.isSafeInteger(this.maxPageBytes) ||
      this.maxPageBytes < 1 ||
      this.maxPageBytes > 1_000_000
    ) {
      throw new RangeError(
        "Confluence page byte limit must be between 1 and 1000000.",
      );
    }
  }

  async getPage(
    target: ConfluencePageTarget,
    fetchedAt: Date = new Date(),
  ): Promise<ConfluencePage> {
    validateTarget(target);
    const cloudId = await this.resolveCloudId(target.siteId);
    const url = new URL(
      `/ex/confluence/${cloudId}/wiki/api/v2/pages/${target.pageId}`,
      "https://api.atlassian.com",
    );
    url.searchParams.set("body-format", "storage");
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: this.authorization,
      },
      redirect: "error",
    });
    if (!response.ok) {
      throw new ConfluencePageRequestError(response.status);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxPageBytes
    ) {
      throw new RangeError("Confluence page response exceeds the byte limit.");
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody) > this.maxPageBytes) {
      throw new RangeError("Confluence page response exceeds the byte limit.");
    }
    const page = pageSchema.parse(JSON.parse(responseBody));
    if (page.id !== target.pageId || page.status !== "current") {
      throw new Error("Confluence returned an unexpected page identity or status.");
    }
    return {
      siteId: target.siteId,
      pageId: page.id,
      version: page.version.number,
      status: page.status,
      title: page.title,
      spaceId: page.spaceId,
      parentId: page.parentId ?? null,
      bodyStorageValue: page.body.storage.value,
      bodyHash: hashConfluenceBody(page.body.storage.value),
      fetchedAt,
    };
  }

  private resolveCloudId(siteId: string): Promise<string> {
    const existing = this.cloudIds.get(siteId);
    if (existing) {
      return existing;
    }
    const resolution = this.fetchCloudId(siteId);
    this.cloudIds.set(siteId, resolution);
    return resolution;
  }

  private async fetchCloudId(siteId: string): Promise<string> {
    const response = await this.fetch(
      new URL("/_edge/tenant_info", `https://${siteId}`),
      {
        headers: { Accept: "application/json" },
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new ConfluencePageRequestError(response.status);
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody) > 10_000) {
      throw new RangeError(
        "Atlassian tenant information exceeds the byte limit.",
      );
    }
    return tenantSchema.parse(JSON.parse(responseBody)).cloudId;
  }
}

function validateTarget(target: ConfluencePageTarget): void {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(
      target.siteId,
    ) ||
    !/^\d+$/.test(target.pageId)
  ) {
    throw new Error("Confluence target is invalid.");
  }
}
