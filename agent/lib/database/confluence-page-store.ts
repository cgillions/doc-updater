import type { ConfluencePage } from "../domain/documentation/confluence-page.ts";
import { ReviewRecordConflictError } from "../domain/reviews/errors.ts";
import type { PrismaClient } from "./generated/client.ts";

export interface ConfluenceCandidateTarget {
  siteId: string;
  pageId: string;
  label: string;
}

export interface StoredConfluenceCandidate {
  id: string;
  reviewJobId: string;
  siteId: string;
  pageId: string;
  label: string;
  snapshot: StoredConfluenceSnapshot | null;
}

export interface StoredConfluenceSnapshot {
  id: string;
  siteId: string;
  pageId: string;
  version: number;
  title: string;
  bodyStorageValue: string;
  bodyHash: string;
}

/** Persists job-scoped opaque candidates and shared immutable page versions. */
export class ConfluencePageStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  async materializeCandidates(
    reviewJobId: string,
    targets: readonly ConfluenceCandidateTarget[],
  ): Promise<StoredConfluenceCandidate[]> {
    return this.database.$transaction(async (transaction) => {
      for (const target of targets) {
        await transaction.reviewJobConfluenceCandidate.upsert({
          where: {
            reviewJobId_siteId_pageId: {
              reviewJobId,
              siteId: target.siteId,
              pageId: target.pageId,
            },
          },
          create: { reviewJobId, ...target },
          update: { label: target.label },
        });
      }
      const candidates =
        await transaction.reviewJobConfluenceCandidate.findMany({
          where: { reviewJobId },
          include: { snapshot: true },
          orderBy: [{ label: "asc" }, { id: "asc" }],
        });
      return candidates.map(toCandidate);
    });
  }

  async loadCandidate(
    reviewJobId: string,
    candidateId: string,
  ): Promise<StoredConfluenceCandidate | null> {
    const candidate =
      await this.database.reviewJobConfluenceCandidate.findFirst({
        where: { id: candidateId, reviewJobId },
        include: { snapshot: true },
      });
    return candidate ? toCandidate(candidate) : null;
  }

  async attachSnapshot(
    reviewJobId: string,
    candidateId: string,
    page: ConfluencePage,
  ): Promise<StoredConfluenceCandidate> {
    return this.database.$transaction(async (transaction) => {
      const candidate =
        await transaction.reviewJobConfluenceCandidate.findFirst({
          where: { id: candidateId, reviewJobId },
        });
      if (
        !candidate ||
        candidate.siteId !== page.siteId ||
        candidate.pageId !== page.pageId
      ) {
        throw new ReviewRecordConflictError(
          "Confluence candidate is outside the assigned review job.",
        );
      }

      await transaction.confluencePageSnapshot.createMany({
        data: [page],
        skipDuplicates: true,
      });
      const snapshot = await transaction.confluencePageSnapshot.findUnique({
        where: {
          siteId_pageId_version: {
            siteId: page.siteId,
            pageId: page.pageId,
            version: page.version,
          },
        },
      });
      if (
        !snapshot ||
        snapshot.bodyHash !== page.bodyHash ||
        snapshot.bodyStorageValue !== page.bodyStorageValue ||
        snapshot.status !== page.status ||
        snapshot.title !== page.title ||
        snapshot.spaceId !== page.spaceId ||
        snapshot.parentId !== page.parentId
      ) {
        throw new ReviewRecordConflictError(
          "Confluence returned different content for an existing page version.",
        );
      }
      const updated =
        await transaction.reviewJobConfluenceCandidate.update({
          where: { id: candidate.id },
          data: { snapshotId: snapshot.id },
          include: { snapshot: true },
        });
      return toCandidate(updated);
    });
  }
}

function toCandidate(candidate: {
  id: string;
  reviewJobId: string;
  siteId: string;
  pageId: string;
  label: string;
  snapshot: {
    id: string;
    siteId: string;
    pageId: string;
    version: number;
    title: string;
    bodyStorageValue: string;
    bodyHash: string;
  } | null;
}): StoredConfluenceCandidate {
  return {
    id: candidate.id,
    reviewJobId: candidate.reviewJobId,
    siteId: candidate.siteId,
    pageId: candidate.pageId,
    label: candidate.label,
    snapshot: candidate.snapshot,
  };
}
