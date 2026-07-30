import type { Prisma } from "./generated/client.ts";
import type { PrismaClient } from "./generated/client.ts";

import type { RepositorySearchAuditor } from "../application/repositories/read-assigned-repository.ts";

/** Persists audit events for model-visible repository search. */
export class RepositorySearchAuditStore implements RepositorySearchAuditor {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  async recordSearch(input: {
    reviewJobId: string;
    repositoryId: string;
    revision: "base" | "head";
    gitSha: string;
    query: string;
    returnedPaths: string[];
    resultCount: number;
    truncated: boolean;
    errorMessage?: string;
    actorId?: string;
    toolCallId?: string;
  }): Promise<void> {
    const idempotencyKey = input.toolCallId
      ? `repository-search:${input.reviewJobId}:${input.toolCallId}`
      : `repository-search:${input.reviewJobId}:${searchAuditReplayKey(input)}`;
    await this.database.auditEvent.upsert({
      where: { idempotencyKey },
      create: {
        repositoryId: input.repositoryId,
        reviewJobId: input.reviewJobId,
        eventType: "repository_search_performed",
        idempotencyKey,
        actorId: input.actorId,
        details: {
          query: input.query,
          revision: input.revision,
          gitSha: input.gitSha,
          returnedPaths: input.returnedPaths,
          resultCount: input.resultCount,
          truncated: input.truncated,
          ...(input.errorMessage
            ? { errorMessage: input.errorMessage.slice(0, 1_000) }
            : {}),
        } satisfies Prisma.InputJsonObject,
      },
      update: {},
    });
  }
}

function searchAuditReplayKey(input: {
  revision: "base" | "head";
  gitSha: string;
  query: string;
  returnedPaths: string[];
}): string {
  return Buffer.from(
    JSON.stringify({
      revision: input.revision,
      gitSha: input.gitSha,
      query: input.query,
      returnedPaths: input.returnedPaths,
    }),
  )
    .toString("base64url")
    .slice(0, 160);
}
