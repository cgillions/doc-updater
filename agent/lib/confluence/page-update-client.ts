import { z } from "zod";

import type { ConfluencePageUpdater } from "../application/documentation/publish-confluence-page-update.ts";
import { loadConfluenceClientConfig } from "../config/confluence-client-config.ts";
import type { ConfluencePage } from "../domain/documentation/confluence-page.ts";

const tenantSchema = z.object({ cloudId: z.uuid() });
const updateResponseSchema = z.object({
  id: z.string().regex(/^\d+$/),
  status: z.literal("current"),
  version: z.object({ number: z.number().int().positive() }),
  _links: z.object({ webui: z.string().min(1) }),
});

export interface ConfluencePageUpdateClientOptions {
  apiToken: string;
  fetch?: typeof fetch;
}

export class ConfluencePageUpdateRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Confluence page update failed with status ${status}.`);
    this.name = "ConfluencePageUpdateRequestError";
    this.status = status;
  }
}

/** Publishes one exact, version-guarded update to an existing Confluence page. */
export class ConfluencePageUpdateClient implements ConfluencePageUpdater {
  private readonly authorization: string;
  private readonly cloudIds = new Map<string, Promise<string>>();
  private readonly fetch: typeof fetch;

  constructor(options: ConfluencePageUpdateClientOptions) {
    if (!options.apiToken.trim()) {
      throw new Error("A Confluence API token is required.");
    }
    this.authorization = `Bearer ${options.apiToken}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async updatePage(
    input: Parameters<ConfluencePageUpdater["updatePage"]>[0],
  ): Promise<Awaited<ReturnType<ConfluencePageUpdater["updatePage"]>>> {
    validateInput(input);
    const cloudId = await this.resolveCloudId(input.page.siteId);
    const response = await this.fetch(
      new URL(
        `/ex/confluence/${cloudId}/wiki/api/v2/pages/${input.page.pageId}`,
        "https://api.atlassian.com",
      ),
      {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: this.authorization,
        },
        body: JSON.stringify({
          id: input.page.pageId,
          status: "current",
          title: input.page.title,
          spaceId: input.page.spaceId,
          parentId: input.page.parentId,
          body: {
            representation: "storage",
            value: input.bodyStorageValue,
          },
          version: {
            number: input.page.version + 1,
            message: input.auditMessage,
          },
        }),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new ConfluencePageUpdateRequestError(response.status);
    }
    const updated = updateResponseSchema.parse(await response.json());
    if (
      updated.id !== input.page.pageId ||
      updated.version.number !== input.page.version + 1
    ) {
      throw new Error("Confluence did not update the expected page version.");
    }
    const pageUrl = buildPageUrl(input.page.siteId, updated._links.webui);
    return {
      pageId: updated.id,
      publishedVersion: updated.version.number,
      status: "published",
      pageUrl,
      historyUrl: buildHistoryUrl(pageUrl, updated.id),
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
      throw new ConfluencePageUpdateRequestError(response.status);
    }
    return tenantSchema.parse(await response.json()).cloudId;
  }
}

export function createConfluencePageUpdateClient(): ConfluencePageUpdateClient {
  return new ConfluencePageUpdateClient(loadConfluenceClientConfig());
}

function buildPageUrl(siteId: string, webui: string): string {
  const path = webui.startsWith("/wiki/")
    ? webui
    : `/wiki/${webui.replace(/^\/+/, "")}`;
  const pageUrl = new URL(path, `https://${siteId}`);
  if (pageUrl.hostname !== siteId) {
    throw new Error("Confluence returned an invalid page URL.");
  }
  return pageUrl.toString();
}

function buildHistoryUrl(pageUrl: string, pageId: string): string {
  const url = new URL(pageUrl);
  const marker = `/pages/${pageId}`;
  if (!url.pathname.includes(marker)) {
    throw new Error("Confluence returned a page URL without the expected page.");
  }
  url.pathname = url.pathname.replace(marker, `/history/${pageId}`);
  return url.toString();
}

function validateInput(input: {
  page: ConfluencePage;
  bodyStorageValue: string;
  auditMessage: string;
}): void {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(
      input.page.siteId,
    ) ||
    !/^\d+$/.test(input.page.pageId) ||
    input.page.status !== "current" ||
    !Number.isSafeInteger(input.page.version) ||
    input.page.version < 1 ||
    !input.page.title ||
    !input.page.spaceId ||
    !input.bodyStorageValue ||
    Buffer.byteLength(input.bodyStorageValue) > 1_000_000 ||
    !input.auditMessage ||
    input.auditMessage.length > 255
  ) {
    throw new Error("Confluence page update input is invalid.");
  }
}
