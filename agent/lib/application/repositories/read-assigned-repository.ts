import {
  AssignedReviewJobLoader,
  type ActiveReviewJobContextSource,
  type ReviewSessionAuth,
} from "../review-jobs/load-assigned-review-job.ts";
import type {
  RepositoryFileCoordinates,
  RepositoryReviewCoordinates,
  RepositorySearchCoordinates,
} from "../../github/repository-review-client.ts";
import type {
  RepositoryFileContent,
  RepositoryFileRequest,
  RepositorySearchRequest,
  RepositorySearchResponse,
  RepositoryReviewScope,
} from "../../domain/repositories/repository-review.ts";

/** Read-only repository evidence boundary used by the application workflow. */
export interface RepositoryReviewSource {
  loadScope(
    coordinates: RepositoryReviewCoordinates,
  ): Promise<RepositoryReviewScope>;
  readFile(
    coordinates: RepositoryFileCoordinates,
  ): Promise<RepositoryFileContent>;
  search(
    coordinates: RepositorySearchCoordinates,
    request: Omit<RepositorySearchRequest, "revision">,
  ): Promise<RepositorySearchResponse>;
}

/** Audit boundary for model-visible repository search. */
export interface RepositorySearchAuditor {
  recordSearch(input: {
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
  }): Promise<void>;
}

/** Raised when a reconciliation job is asked for a nonexistent base. */
export class BaseRevisionUnavailableError extends Error {
  constructor() {
    super("The assigned reconciliation review has no base revision.");
    this.name = "BaseRevisionUnavailableError";
  }
}

/**
 * Restricts repository evidence reads to a trusted session's assigned job.
 *
 * Repository identity and SHAs are never accepted as model input.
 */
export class AssignedRepositoryReader {
  private readonly jobs: AssignedReviewJobLoader;
  private readonly repositories: RepositoryReviewSource;

  constructor(
    jobs: ActiveReviewJobContextSource,
    repositories: RepositoryReviewSource,
  ) {
    this.jobs = new AssignedReviewJobLoader(jobs);
    this.repositories = repositories;
  }

  /**
   * Loads the assigned repository's complete bounded review scope.
   *
   * @returns Changed implementation paths and candidate repository docs.
   */
  async loadScope(auth: ReviewSessionAuth): Promise<RepositoryReviewScope> {
    const job = await this.jobs.load(auth);
    return this.repositories.loadScope({
      repositoryFullName: job.repository.fullName,
      mode: job.mode,
      baseSha: job.baseSha,
      headSha: job.headSha,
    });
  }

  /**
   * Reads a path at either the assigned base or head revision.
   *
   * @returns Exact UTF-8 content with its immutable revision and digest.
   */
  async readFile(
    auth: ReviewSessionAuth,
    request: RepositoryFileRequest,
  ): Promise<RepositoryFileContent> {
    const job = await this.jobs.load(auth);
    const gitSha = resolveRevisionSha(
      request.revision,
      job.baseSha,
      job.headSha,
    );
    return this.repositories.readFile({
      repositoryFullName: job.repository.fullName,
      path: request.path,
      revision: request.revision,
      gitSha,
    });
  }

  /**
   * Searches bounded text snippets at either assigned revision.
   *
   * The model supplies only the query and base/head selector; repository
   * identity and exact SHA remain bound to the active review job.
   */
  async search(
    auth: ReviewSessionAuth,
    request: RepositorySearchRequest,
    auditor: RepositorySearchAuditor,
    options: { toolCallId?: string } = {},
  ): Promise<RepositorySearchResponse> {
    const job = await this.jobs.load(auth);
    const gitSha = resolveRevisionSha(
      request.revision,
      job.baseSha,
      job.headSha,
    );
    try {
      const response = await this.repositories.search(
        {
          repositoryFullName: job.repository.fullName,
          revision: request.revision,
          gitSha,
        },
        {
          query: request.query,
          maxResults: request.maxResults,
        },
      );
      await auditor.recordSearch({
        reviewJobId: job.reviewJobId,
        repositoryId: job.repository.id,
        revision: request.revision,
        gitSha,
        query: response.query,
        returnedPaths: [...new Set(response.results.map(({ path }) => path))],
        resultCount: response.results.length,
        truncated: response.truncated,
        actorId: auth.current?.principalId,
        toolCallId: options.toolCallId,
      });
      return response;
    } catch (error) {
      await auditor.recordSearch({
        reviewJobId: job.reviewJobId,
        repositoryId: job.repository.id,
        revision: request.revision,
        gitSha,
        query: request.query,
        returnedPaths: [],
        resultCount: 0,
        truncated: true,
        errorMessage:
          error instanceof Error ? error.message : "Unknown search failure.",
        actorId: auth.current?.principalId,
        toolCallId: options.toolCallId,
      });
      throw error;
    }
  }
}

function resolveRevisionSha(
  revision: RepositoryFileRequest["revision"],
  baseSha: string | null,
  headSha: string,
): string {
  if (revision === "head") {
    return headSha;
  }
  if (!baseSha) {
    throw new BaseRevisionUnavailableError();
  }
  return baseSha;
}
