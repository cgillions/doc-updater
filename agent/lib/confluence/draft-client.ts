import { z } from "zod";

import { loadConfluenceClientConfig } from "../config/confluence-client-config.ts";
import type { ConfluencePage } from "../domain/documentation/confluence-page.ts";
import type { ConfluenceDraftCreator } from "../application/documentation/create-confluence-draft.ts";

const tenantSchema = z.object({
  cloudId: z.uuid(),
});

const draftResponseSchema = z.object({
  id: z.string().regex(/^\d+$/),
  status: z.string().min(1),
  version: z.object({
    number: z.number().int().positive(),
  }),
});

export interface ConfluenceDraftClientOptions {
  apiToken: string;
  fetch?: typeof fetch;
}

/** Raised when Confluence rejects the narrowly scoped draft update. */
export class ConfluenceDraftRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Confluence draft request failed with status ${status}.`);
    this.name = "ConfluenceDraftRequestError";
    this.status = status;
  }
}

/**
 * Writes one existing page as an unpublished Confluence storage-format draft.
 *
 * This client intentionally has no create, publish, delete, move, permission,
 * or space-management operation.
 */
export class ConfluenceDraftClient implements ConfluenceDraftCreator {
  private readonly authorization: string;
  private readonly cloudIds = new Map<string, Promise<string>>();
  private readonly fetch: typeof fetch;

  constructor(options: ConfluenceDraftClientOptions) {
    if (!options.apiToken.trim()) {
      throw new Error("A Confluence API token is required.");
    }
    this.authorization = `Bearer ${options.apiToken}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async createDraft(
    input: Parameters<ConfluenceDraftCreator["createDraft"]>[0],
  ): Promise<{
    draftPageId: string;
    draftVersion: number;
    status: "draft";
  }> {
    validateDraftInput(input);
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
          status: "draft",
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
      throw new ConfluenceDraftRequestError(response.status);
    }
    const draft = draftResponseSchema.parse(await response.json());
    if (draft.id !== input.page.pageId || draft.status !== "draft") {
      throw new Error(
        "Confluence did not return an unpublished draft for the expected page.",
      );
    }
    return {
      draftPageId: draft.id,
      draftVersion: draft.version.number,
      status: "draft",
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
      throw new ConfluenceDraftRequestError(response.status);
    }
    return tenantSchema.parse(await response.json()).cloudId;
  }
}

/** Creates the trusted draft writer; model-visible tools never receive it. */
export function createConfluenceDraftClient(): ConfluenceDraftClient {
  return new ConfluenceDraftClient(loadConfluenceClientConfig());
}

function validateDraftInput(input: {
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
    throw new Error("Confluence draft input is invalid.");
  }
}
