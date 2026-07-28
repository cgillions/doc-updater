import { z } from "zod";

import type { RepositoryPullRequestCreator } from "../application/repositories/create-repository-pull-request.ts";
import type { GitHubAccessTokenProvider } from "./control-plane-client.ts";

const GITHUB_API_VERSION = "2026-03-10";

const gitReferenceSchema = z.object({
  object: z.object({
    type: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  }),
});

const contentSchema = z.object({
  type: z.literal("file"),
  sha: z.string().min(1),
  content: z.string(),
  encoding: z.literal("base64"),
});

const updateFileSchema = z.object({
  commit: z.object({
    sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  }),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
});

const commitSchema = z.object({
  parents: z.array(
    z.object({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }),
  ),
});

/** Dependencies for the application-owned GitHub pull-request writer. */
export interface GitHubRepositoryPullRequestClientOptions {
  getAccessToken: GitHubAccessTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

/** Raised when GitHub rejects a pull-request writer request. */
export class GitHubRepositoryPullRequestRequestError extends Error {
  readonly requestPath: string;
  readonly status: number;

  constructor(requestPath: string, status: number) {
    super(`GitHub request ${requestPath} failed with status ${status}.`);
    this.name = "GitHubRepositoryPullRequestRequestError";
    this.requestPath = requestPath;
    this.status = status;
  }
}

/** Raised when the default branch changes during approved artifact creation. */
export class GitHubRepositoryPullRequestStaleBaseError extends Error {
  constructor(expectedBaseSha: string, actualBaseSha: string) {
    super(
      `Repository default branch moved from proposal base ${expectedBaseSha} ` +
        `to ${actualBaseSha}.`,
    );
    this.name = "GitHubRepositoryPullRequestStaleBaseError";
  }
}

/** Raised when a deterministic branch contains content not created by this proposal. */
export class GitHubRepositoryPullRequestBranchConflictError extends Error {
  constructor(branchName: string) {
    super(
      `Repository branch ${JSON.stringify(branchName)} does not contain the ` +
        "expected proposal commit.",
    );
    this.name = "GitHubRepositoryPullRequestBranchConflictError";
  }
}

/**
 * Creates a branch, one documentation commit, and one pull request.
 *
 * The client has no merge operation. It is only constructed by the trusted
 * artifact-creation tool, never exposed as a model-visible connection.
 */
export class GitHubRepositoryPullRequestClient
  implements RepositoryPullRequestCreator
{
  private readonly getAccessToken: GitHubAccessTokenProvider;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: URL;

  constructor(options: GitHubRepositoryPullRequestClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
  }

  /** Reads the current default-branch SHA immediately before a write. */
  async readDefaultBranchHead(input: {
    repositoryFullName: string;
    defaultBranch: string;
  }): Promise<string> {
    const token = await this.getToken();
    return this.readBranchHead(token, input.repositoryFullName, input.defaultBranch);
  }

  /**
   * Idempotently creates the proposal's branch, commit, and pull request.
   *
   * Replays reuse the deterministic branch and return an existing pull request
   * rather than creating another one.
   */
  async create(input: Parameters<RepositoryPullRequestCreator["create"]>[0]) {
    validateCreateInput(input);
    const token = await this.getToken();
    const currentBaseSha = await this.readBranchHead(
      token,
      input.repositoryFullName,
      input.defaultBranch,
    );
    if (currentBaseSha !== input.baseSha) {
      throw new GitHubRepositoryPullRequestStaleBaseError(
        input.baseSha,
        currentBaseSha,
      );
    }

    const branchHead = await this.ensureBranch(token, input);
    const commitSha = await this.ensureFileReplacement(token, input, branchHead);

    const finalBaseSha = await this.readBranchHead(
      token,
      input.repositoryFullName,
      input.defaultBranch,
    );
    if (finalBaseSha !== input.baseSha) {
      throw new GitHubRepositoryPullRequestStaleBaseError(
        input.baseSha,
        finalBaseSha,
      );
    }

    const pullRequest = await this.ensurePullRequest(token, input);
    return {
      commitSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
    };
  }

  private async ensureBranch(
    token: string,
    input: Parameters<RepositoryPullRequestCreator["create"]>[0],
  ): Promise<string> {
    const existing = await this.findBranchHead(
      token,
      input.repositoryFullName,
      input.branchName,
    );
    if (existing) {
      return existing;
    }

    const [owner, repository] = parseRepositoryFullName(input.repositoryFullName);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      "/git/refs";
    try {
      const response = await this.request(token, requestPath, {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${input.branchName}`,
          sha: input.baseSha,
        }),
      });
      return gitReferenceSchema.parse(await response.json()).object.sha;
    } catch (error) {
      if (
        !(error instanceof GitHubRepositoryPullRequestRequestError) ||
        error.status !== 422
      ) {
        throw error;
      }
      const racedBranch = await this.findBranchHead(
        token,
        input.repositoryFullName,
        input.branchName,
      );
      if (!racedBranch) {
        throw error;
      }
      return racedBranch;
    }
  }

  private async ensureFileReplacement(
    token: string,
    input: Parameters<RepositoryPullRequestCreator["create"]>[0],
    branchHead: string,
  ): Promise<string> {
    const file = await this.readFile(token, input.repositoryFullName, input.path, input.branchName);
    if (file.content === input.content) {
      if (branchHead === input.baseSha) {
        throw new GitHubRepositoryPullRequestBranchConflictError(input.branchName);
      }
      const parentSha = await this.readFirstParent(
        token,
        input.repositoryFullName,
        branchHead,
      );
      if (parentSha !== input.baseSha) {
        throw new GitHubRepositoryPullRequestBranchConflictError(input.branchName);
      }
      return branchHead;
    }
    if (branchHead !== input.baseSha) {
      throw new GitHubRepositoryPullRequestBranchConflictError(input.branchName);
    }

    const [owner, repository] = parseRepositoryFullName(input.repositoryFullName);
    const encodedPath = encodeRepositoryPath(input.path);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/contents/${encodedPath}`;
    const response = await this.request(token, requestPath, {
      method: "PUT",
      body: JSON.stringify({
        message: input.commitMessage,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branchName,
        sha: file.sha,
      }),
    });
    return updateFileSchema.parse(await response.json()).commit.sha;
  }

  private async ensurePullRequest(
    token: string,
    input: Parameters<RepositoryPullRequestCreator["create"]>[0],
  ): Promise<z.infer<typeof pullRequestSchema>> {
    const [owner, repository] = parseRepositoryFullName(input.repositoryFullName);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branchName}`)}`;
    const existingResponse = await this.request(token, requestPath);
    const existing = z.array(pullRequestSchema).parse(await existingResponse.json());
    if (existing.length > 0) {
      return existing[0]!;
    }

    const createResponse = await this.request(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          head: input.branchName,
          base: input.defaultBranch,
          body: input.body,
        }),
      },
    );
    return pullRequestSchema.parse(await createResponse.json());
  }

  private async readBranchHead(
    token: string,
    repositoryFullName: string,
    branchName: string,
  ): Promise<string> {
    const [owner, repository] = parseRepositoryFullName(repositoryFullName);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/git/ref/heads/${encodeURIComponent(branchName)}`;
    const response = await this.request(token, requestPath);
    return gitReferenceSchema.parse(await response.json()).object.sha;
  }

  private async findBranchHead(
    token: string,
    repositoryFullName: string,
    branchName: string,
  ): Promise<string | null> {
    try {
      return await this.readBranchHead(token, repositoryFullName, branchName);
    } catch (error) {
      if (
        error instanceof GitHubRepositoryPullRequestRequestError &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  private async readFile(
    token: string,
    repositoryFullName: string,
    path: string,
    revision: string,
  ): Promise<{ sha: string; content: string }> {
    const [owner, repository] = parseRepositoryFullName(repositoryFullName);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(revision)}`;
    const response = await this.request(token, requestPath);
    const parsed = contentSchema.parse(await response.json());
    return {
      sha: parsed.sha,
      content: decodeUtf8Base64(parsed.content, path),
    };
  }

  private async readFirstParent(
    token: string,
    repositoryFullName: string,
    commitSha: string,
  ): Promise<string | null> {
    const [owner, repository] = parseRepositoryFullName(repositoryFullName);
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/git/commits/${commitSha}`;
    const response = await this.request(token, requestPath);
    return commitSchema.parse(await response.json()).parents[0]?.sha ?? null;
  }

  private async getToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (token.length === 0) {
      throw new Error("GitHub access token provider returned an empty token.");
    }
    return token;
  }

  private async request(
    token: string,
    requestPath: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(requestPath, this.apiBaseUrl);
    const response = await this.fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "documentation-drift-pr-creator",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new GitHubRepositoryPullRequestRequestError(
        `${url.pathname}${url.search}`,
        response.status,
      );
    }
    return response;
  }
}

function validateCreateInput(
  input: Parameters<RepositoryPullRequestCreator["create"]>[0],
): void {
  parseRepositoryFullName(input.repositoryFullName);
  validateGitSha(input.baseSha);
  validateBranchName(input.defaultBranch);
  validateBranchName(input.branchName);
  validateRepositoryPath(input.path);
  if (input.idempotencyKey.length === 0) {
    throw new Error("A repository pull-request idempotency key is required.");
  }
}

function parseRepositoryFullName(value: string): [string, string] {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) {
    throw new Error(`GitHub repository name ${JSON.stringify(value)} is invalid.`);
  }
  return [match[1], match[2]];
}

function validateGitSha(value: string): void {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) {
    throw new Error(`Git SHA ${JSON.stringify(value)} is invalid.`);
  }
}

function validateBranchName(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    /[~^:?*\\[\\\s]/.test(value)
  ) {
    throw new Error(`Git branch ${JSON.stringify(value)} is invalid.`);
  }
}

function validateRepositoryPath(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Repository path ${JSON.stringify(value)} is invalid.`);
  }
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeUtf8Base64(value: string, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(value.replace(/\n/g, ""), "base64"),
    );
  } catch {
    throw new Error(`Repository file ${JSON.stringify(path)} is not UTF-8.`);
  }
}

function validateApiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? "https://api.github.com/");
  if (url.protocol !== "https:") {
    throw new Error("GitHub API base URL must use HTTPS.");
  }
  return url;
}
