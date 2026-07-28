import {
  type ConfluenceCandidateSummary,
  type ConfluenceDocumentCandidate,
  type ConfluencePageTarget,
  type SearchDocumentIndexInput,
} from "../../domain/documentation/confluence-page.ts";
import type { ReviewJobContext } from "../../domain/review-jobs/review-job-context.ts";
import { ReviewRecordConflictError } from "../../domain/reviews/errors.ts";
import type {
  ConfluenceCandidateTarget,
  StoredConfluenceCandidate,
} from "../../database/confluence-page-store.ts";
import {
  AssignedReviewJobLoader,
  resolveAssignedReviewJobId,
  type ActiveReviewJobContextSource,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";

export interface ConfluencePageSource {
  getPage(target: ConfluencePageTarget, fetchedAt?: Date): Promise<{
    siteId: string;
    pageId: string;
    version: number;
    status: string;
    title: string;
    spaceId: string;
    parentId: string | null;
    bodyStorageValue: string;
    bodyHash: string;
    fetchedAt: Date;
  }>;
}

export interface ConfluenceCandidateStore {
  materializeCandidates(
    reviewJobId: string,
    targets: readonly ConfluenceCandidateTarget[],
  ): Promise<StoredConfluenceCandidate[]>;
  loadCandidate(
    reviewJobId: string,
    candidateId: string,
  ): Promise<StoredConfluenceCandidate | null>;
  attachSnapshot(
    reviewJobId: string,
    candidateId: string,
    page: Awaited<ReturnType<ConfluencePageSource["getPage"]>>,
  ): Promise<StoredConfluenceCandidate>;
}

/** Searches and reads only exact Confluence pages assigned to one job. */
export class AssignedConfluencePageReviewer {
  private readonly jobs: AssignedReviewJobLoader;
  private readonly store: ConfluenceCandidateStore;
  private readonly pages: ConfluencePageSource;

  constructor(
    jobs: ActiveReviewJobContextSource,
    store: ConfluenceCandidateStore,
    pages: ConfluencePageSource,
  ) {
    this.jobs = new AssignedReviewJobLoader(jobs);
    this.store = store;
    this.pages = pages;
  }

  async search(
    auth: ReviewSessionAuth,
    input: SearchDocumentIndexInput,
  ): Promise<{ candidates: ConfluenceCandidateSummary[] }> {
    const job = await this.jobs.load(auth);
    const exactTargets = exactCandidateTargets(job);
    if (exactTargets.length > 50) {
      throw new RangeError(
        "Exact Confluence page scope exceeds the 50-page review limit.",
      );
    }
    const candidates = await this.store.materializeCandidates(
      job.reviewJobId,
      exactTargets.map(({ target }) => target),
    );
    const provenanceByIdentity = new Map(
      exactTargets.map(({ target, provenance }) => [
        identity(target),
        provenance,
      ]),
    );
    const queryTokens = tokenize(input.query);
    const indexedCandidates: StoredConfluenceCandidate[] = [];
    for (const candidate of candidates) {
      const page = await this.pages.getPage(candidate);
      indexedCandidates.push(
        await this.store.attachSnapshot(
          job.reviewJobId,
          candidate.id,
          page,
        ),
      );
    }
    return {
      candidates: indexedCandidates
        .map((candidate) => ({
          candidateId: candidate.id,
          label: candidate.label,
          title: candidate.snapshot!.title,
          version: candidate.snapshot!.version,
          excerpt: excerpt(candidate.snapshot!.bodyStorageValue),
          provenance:
            provenanceByIdentity.get(identity(candidate)) ?? [],
          score: lexicalScore(
            `${candidate.label} ${candidate.snapshot!.title} ` +
            `${candidate.snapshot!.bodyStorageValue} ${
              (provenanceByIdentity.get(identity(candidate)) ?? [])
                .map(({ entityRef, title }) => `${entityRef} ${title ?? ""}`)
                .join(" ")
            }`,
            queryTokens,
          ),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.label.localeCompare(right.label) ||
            left.candidateId.localeCompare(right.candidateId),
        )
        .slice(0, input.limit)
        .map(({ score: _score, ...candidate }) => candidate),
    };
  }

  async get(
    auth: ReviewSessionAuth,
    candidateId: string,
  ): Promise<ConfluenceDocumentCandidate> {
    const reviewJobId = resolveAssignedReviewJobId(auth);
    const candidate = await this.store.loadCandidate(
      reviewJobId,
      candidateId,
    );
    if (!candidate?.snapshot) {
      throw new ReviewRecordConflictError(
        "Confluence candidate is outside the assigned review job or has not been indexed.",
      );
    }
    const snapshot = candidate.snapshot;
    return {
      candidateId,
      title: snapshot.title,
      version: snapshot.version,
      bodyHash: snapshot.bodyHash,
      bodyStorageValue: snapshot.bodyStorageValue,
    };
  }
}

function exactCandidateTargets(job: ReviewJobContext): Array<{
  target: ConfluenceCandidateTarget;
  provenance: ConfluenceCandidateSummary["provenance"];
}> {
  return job.documentationScope
    .filter((document) =>
      document.declarations.some(({ kind }) => kind === "exact"),
    )
    .map((document) => {
      const exactDeclarations = document.declarations.filter(
        ({ kind }) => kind === "exact",
      );
      const provenance = exactDeclarations.map(({ provenance: source }) => ({
        entityRef: source.entityRef,
        ...(source.title ? { title: source.title } : {}),
      }));
      return {
        target: {
          siteId: document.siteId,
          pageId: document.pageId,
          label:
            exactDeclarations.find(({ provenance: source }) => source.title)
              ?.provenance.title ??
            provenance[0]?.entityRef ??
            "Confluence page",
        },
        provenance,
      };
    });
}

function identity(target: { siteId: string; pageId: string }): string {
  return `${target.siteId}\0${target.pageId}`;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function lexicalScore(value: string, queryTokens: readonly string[]): number {
  const normalized = value.toLowerCase();
  return queryTokens.reduce(
    (score, token) => score + (normalized.includes(token) ? 1 : 0),
    0,
  );
}

function excerpt(storageValue: string): string {
  return storageValue
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
