import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  RepositoryFileContent,
  RepositoryReviewScope,
} from "../domain/repositories/repository-review.ts";
import type { GitHubAccessTokenProvider } from "./control-plane-client.ts";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_COMPARE_FILE_LIMIT = 300;
const DEFAULT_MAX_RECONCILIATION_FILES = 1_000;
const DEFAULT_MAX_DOCUMENTATION_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const compareSchema = z.object({
  total_commits: z.number().int().nonnegative(),
  commits: z.array(
    z.object({
      sha: gitShaSchema,
      commit: z.object({
        message: z.string(),
      }),
      parents: z.array(
        z.object({
          sha: gitShaSchema,
        }),
      ),
    }),
  ),
  files: z.array(
    z.object({
      filename: z.string().min(1),
      previous_filename: z.string().min(1).optional(),
      status: z.string().min(1),
      patch: z.string().min(1).optional(),
    }),
  ),
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1),
      type: z.enum(["blob", "tree", "commit"]),
    }),
  ),
});

/** Immutable repository coordinates taken from an assigned review job. */
export interface RepositoryReviewCoordinates {
  repositoryFullName: string;
  mode: "INCREMENTAL" | "RECONCILIATION";
  baseSha: string | null;
  headSha: string;
}

/** Coordinates for one exact repository file read. */
export interface RepositoryFileCoordinates {
  repositoryFullName: string;
  path: string;
  revision: "base" | "head";
  gitSha: string;
}

/** Dependencies and evidence limits for repository review reads. */
export interface GitHubRepositoryReviewClientOptions {
  getAccessToken: GitHubAccessTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  maxReconciliationFiles?: number;
  maxDocumentationFiles?: number;
  maxFileBytes?: number;
}

/** Raised when GitHub cannot supply a complete, bounded evidence set. */
export class GitHubRepositoryReviewLimitError extends Error {
  readonly limit: "comparison" | "tree" | "documentation" | "file";

  constructor(
    limit: "comparison" | "tree" | "documentation" | "file",
    message: string,
  ) {
    super(message);
    this.name = "GitHubRepositoryReviewLimitError";
    this.limit = limit;
  }
}

/** Raised when a model-selected path is not a safe repository-relative path. */
export class InvalidRepositoryPathError extends Error {
  constructor(path: string) {
    super(`Repository path ${JSON.stringify(path)} is invalid.`);
    this.name = "InvalidRepositoryPathError";
  }
}

/** Raised when a read-only GitHub review request returns a failure. */
export class GitHubRepositoryReviewRequestError extends Error {
  readonly requestPath: string;
  readonly status: number;

  constructor(requestPath: string, status: number) {
    super(`GitHub request ${requestPath} failed with status ${status}.`);
    this.name = "GitHubRepositoryReviewRequestError";
    this.requestPath = requestPath;
    this.status = status;
  }
}

/**
 * Reads repository implementation and documentation at job-assigned SHAs.
 *
 * The client exposes no mutation operations and fails rather than returning
 * partial evidence when GitHub or configured bounds truncate a review.
 */
export class GitHubRepositoryReviewClient {
  private readonly getAccessToken: GitHubAccessTokenProvider;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: URL;
  private readonly maxReconciliationFiles: number;
  private readonly maxDocumentationFiles: number;
  private readonly maxFileBytes: number;

  constructor(options: GitHubRepositoryReviewClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.maxReconciliationFiles = validatePositiveLimit(
      options.maxReconciliationFiles ?? DEFAULT_MAX_RECONCILIATION_FILES,
      "reconciliation file",
    );
    this.maxDocumentationFiles = validatePositiveLimit(
      options.maxDocumentationFiles ?? DEFAULT_MAX_DOCUMENTATION_FILES,
      "documentation file",
    );
    this.maxFileBytes = validatePositiveLimit(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "repository file byte",
    );
  }

  /**
   * Loads changed paths and all candidate repository documentation at head.
   *
   * @returns A complete, deterministic scope bound to the supplied SHAs.
   * @throws If GitHub returns partial data or an evidence bound is exceeded.
   */
  async loadScope(
    coordinates: RepositoryReviewCoordinates,
  ): Promise<RepositoryReviewScope> {
    validateCoordinates(coordinates);
    const token = await this.getToken();
    const comparison =
      coordinates.mode === "INCREMENTAL"
        ? await this.loadComparison(token, coordinates)
        : null;
    const treePaths = await this.loadHeadTree(token, coordinates);
    const documentationFiles = treePaths
      .filter(isDocumentationPath)
      .sort();
    if (documentationFiles.length > this.maxDocumentationFiles) {
      throw new GitHubRepositoryReviewLimitError(
        "documentation",
        `Repository contains ${documentationFiles.length} documentation ` +
          `files; the limit is ${this.maxDocumentationFiles}.`,
      );
    }

    const changedFiles =
      comparison?.changedFiles ?? this.mapReconciliationFiles(treePaths);

    return {
      mode: coordinates.mode,
      baseSha: coordinates.baseSha,
      headSha: coordinates.headSha,
      commits: comparison?.commits ?? [],
      changedFiles,
      documentationFiles,
    };
  }

  /**
   * Reads one UTF-8 file from the assigned repository at an exact SHA.
   *
   * @returns Content, byte count, and digest suitable for persisted evidence.
   * @throws If the path is unsafe, content is non-UTF-8, or the limit is met.
   */
  async readFile(
    coordinates: RepositoryFileCoordinates,
  ): Promise<RepositoryFileContent> {
    const [owner, repository] = parseRepositoryFullName(
      coordinates.repositoryFullName,
    );
    validateRepositoryPath(coordinates.path);
    gitShaSchema.parse(coordinates.gitSha);

    const token = await this.getToken();
    const encodedPath = coordinates.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/contents/${encodedPath}?ref=${coordinates.gitSha}`;
    const response = await this.request(token, requestPath, {
      Accept: "application/vnd.github.raw+json",
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxFileBytes
    ) {
      throw this.fileLimitError(coordinates.path);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxFileBytes) {
      throw this.fileLimitError(coordinates.path);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `Repository file ${JSON.stringify(coordinates.path)} is not UTF-8.`,
      );
    }

    return {
      path: coordinates.path,
      revision: coordinates.revision,
      gitSha: coordinates.gitSha,
      byteLength: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      content,
    };
  }

  private async loadHeadTree(
    token: string,
    coordinates: RepositoryReviewCoordinates,
  ): Promise<string[]> {
    const [owner, repository] = parseRepositoryFullName(
      coordinates.repositoryFullName,
    );
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/git/trees/${coordinates.headSha}?recursive=1`;
    const parsed = treeSchema.parse(await this.getJson(token, requestPath));
    if (parsed.truncated) {
      throw new GitHubRepositoryReviewLimitError(
        "tree",
        "GitHub truncated the recursive repository tree.",
      );
    }
    return parsed.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
  }

  private async loadComparison(
    token: string,
    coordinates: RepositoryReviewCoordinates,
  ): Promise<
    Pick<RepositoryReviewScope, "changedFiles" | "commits">
  > {
    if (!coordinates.baseSha) {
      throw new Error("Incremental repository review requires a base SHA.");
    }
    const [owner, repository] = parseRepositoryFullName(
      coordinates.repositoryFullName,
    );
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/compare/${coordinates.baseSha}...${coordinates.headSha}`;
    const parsed = compareSchema.parse(await this.getJson(token, requestPath));
    if (parsed.commits.length !== parsed.total_commits) {
      throw new GitHubRepositoryReviewLimitError(
        "comparison",
        `GitHub returned ${parsed.commits.length} of ` +
          `${parsed.total_commits} commits for the comparison.`,
      );
    }
    if (parsed.files.length >= GITHUB_COMPARE_FILE_LIMIT) {
      throw new GitHubRepositoryReviewLimitError(
        "comparison",
        `GitHub comparisons expose at most ${GITHUB_COMPARE_FILE_LIMIT} files.`,
      );
    }
    return {
      commits: parsed.commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        parentShas: commit.parents.map(({ sha }) => sha),
      })),
      changedFiles: parsed.files.map((file) => ({
        path: file.filename,
        ...(file.previous_filename
          ? { previousPath: file.previous_filename }
          : {}),
        status: file.status,
        ...(file.patch ? { patch: file.patch } : {}),
      })),
    };
  }

  private mapReconciliationFiles(
    paths: string[],
  ): RepositoryReviewScope["changedFiles"] {
    if (paths.length > this.maxReconciliationFiles) {
      throw new GitHubRepositoryReviewLimitError(
        "tree",
        `Repository contains ${paths.length} files; the reconciliation limit ` +
          `is ${this.maxReconciliationFiles}.`,
      );
    }
    return paths
      .sort()
      .map((path) => ({ path, status: "present" }));
  }

  private async getToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (token.length === 0) {
      throw new Error("GitHub access token provider returned an empty token.");
    }
    return token;
  }

  private async getJson(token: string, requestPath: string): Promise<unknown> {
    return (await this.request(token, requestPath)).json();
  }

  private async request(
    token: string,
    requestPath: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const url = new URL(requestPath, this.apiBaseUrl);
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "documentation-drift-reviewer",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...extraHeaders,
      },
    });
    if (!response.ok) {
      throw new GitHubRepositoryReviewRequestError(
        `${url.pathname}${url.search}`,
        response.status,
      );
    }
    return response;
  }

  private fileLimitError(path: string): GitHubRepositoryReviewLimitError {
    return new GitHubRepositoryReviewLimitError(
      "file",
      `Repository file ${JSON.stringify(path)} exceeds the ` +
        `${this.maxFileBytes}-byte evidence limit.`,
    );
  }
}

function validateCoordinates(
  coordinates: RepositoryReviewCoordinates,
): void {
  parseRepositoryFullName(coordinates.repositoryFullName);
  gitShaSchema.parse(coordinates.headSha);
  if (coordinates.baseSha !== null) {
    gitShaSchema.parse(coordinates.baseSha);
  }
  if (coordinates.mode === "INCREMENTAL" && !coordinates.baseSha) {
    throw new Error("Incremental repository review requires a base SHA.");
  }
  if (coordinates.mode === "RECONCILIATION" && coordinates.baseSha !== null) {
    throw new Error("Reconciliation repository review cannot have a base SHA.");
  }
}

function parseRepositoryFullName(value: string): [string, string] {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) {
    throw new Error(`GitHub repository name ${JSON.stringify(value)} is invalid.`);
  }
  return [match[1], match[2]];
}

function validateRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new InvalidRepositoryPathError(path);
  }
}

function isDocumentationPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments.at(-1) ?? "";
  const inDocumentationDirectory = segments
    .slice(0, -1)
    .some((segment) => /^(docs?|documentation)$/i.test(segment));
  return (
    /^readme(?:\.|$)/i.test(filename) ||
    /\.(?:md|mdx|adoc|rst)$/i.test(filename) ||
    (inDocumentationDirectory && /\.txt$/i.test(filename))
  );
}

function validateApiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? "https://api.github.com/");
  if (url.protocol !== "https:") {
    throw new Error("GitHub API base URL must use HTTPS.");
  }
  return url;
}

function validatePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} limit must be a positive safe integer.`);
  }
  return value;
}
