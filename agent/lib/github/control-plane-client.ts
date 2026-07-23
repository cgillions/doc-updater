import { getToken } from "@vercel/connect";
import { z } from "zod";

const GITHUB_API_VERSION = "2026-03-10";
const INSTALLATION_PAGE_SIZE = 100;
const DEFAULT_HEAD_REQUEST_CONCURRENCY = 8;
const MAX_HEAD_REQUEST_CONCURRENCY = 25;

const installationRepositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  default_branch: z.string().min(1),
  archived: z.boolean(),
});

const installationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(installationRepositorySchema),
});

const gitReferenceSchema = z.object({
  object: z.object({
    type: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  }),
});

type InstallationRepository = z.infer<typeof installationRepositorySchema>;

/** Repository metadata captured from one complete GitHub App inventory. */
export interface GitHubRepositoryInventoryEntry {
  githubRepositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  defaultBranchHeadSha: string;
  isArchived: boolean;
}

/** Supplies a short-lived GitHub App installation access token. */
export type GitHubAccessTokenProvider = () => Promise<string>;

/** Dependencies and limits for the trusted GitHub inventory client. */
export interface GitHubControlPlaneClientOptions {
  getAccessToken: GitHubAccessTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  headRequestConcurrency?: number;
}

/** Raised when GitHub returns a non-success response. */
export class GitHubControlPlaneRequestError extends Error {
  readonly requestPath: string;
  readonly status: number;

  constructor(requestPath: string, status: number) {
    super(`GitHub request ${requestPath} failed with status ${status}.`);
    this.name = "GitHubControlPlaneRequestError";
    this.requestPath = requestPath;
    this.status = status;
  }
}

/**
 * Read-only GitHub App client used by deterministic control-plane code.
 *
 * A call returns only after every inventory page and default-branch head has
 * been read. Any failed or invalid response rejects the complete snapshot.
 */
export class GitHubControlPlaneClient {
  private readonly getAccessToken: GitHubAccessTokenProvider;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: URL;
  private readonly headRequestConcurrency: number;

  constructor(options: GitHubControlPlaneClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.headRequestConcurrency = validateConcurrency(
      options.headRequestConcurrency ?? DEFAULT_HEAD_REQUEST_CONCURRENCY,
    );
  }

  /**
   * Lists every repository accessible to the current app installation.
   *
   * @returns A complete snapshot including each default branch's current SHA.
   * @throws If token acquisition or any GitHub response fails or is invalid.
   */
  async listInstallationRepositories(): Promise<
    GitHubRepositoryInventoryEntry[]
  > {
    const token = await this.getAccessToken();
    if (token.length === 0) {
      throw new Error("GitHub access token provider returned an empty token.");
    }

    const repositories = await this.listAllRepositoryPages(token);
    return mapWithConcurrency(
      repositories,
      this.headRequestConcurrency,
      async (repository) => ({
        githubRepositoryId: repository.id.toString(),
        repositoryFullName: repository.full_name,
        defaultBranch: repository.default_branch,
        defaultBranchHeadSha: await this.getDefaultBranchHead(
          token,
          repository,
        ),
        isArchived: repository.archived,
      }),
    );
  }

  private async listAllRepositoryPages(
    token: string,
  ): Promise<InstallationRepository[]> {
    const repositories: InstallationRepository[] = [];
    const repositoryIds = new Set<number>();
    let expectedTotal: number | undefined;

    for (let page = 1; ; page += 1) {
      const requestPath =
        `/installation/repositories?per_page=${INSTALLATION_PAGE_SIZE}` +
        `&page=${page}`;
      const body = await this.getJson(token, requestPath);
      const parsed = installationRepositoriesSchema.parse(body);
      expectedTotal ??= parsed.total_count;
      if (parsed.total_count !== expectedTotal) {
        throw new Error(
          "GitHub installation repository count changed during pagination.",
        );
      }

      for (const repository of parsed.repositories) {
        if (repositoryIds.has(repository.id)) {
          throw new Error(
            `GitHub returned repository ID ${repository.id} more than once.`,
          );
        }
        repositoryIds.add(repository.id);
        repositories.push(repository);
      }

      if (repositories.length === expectedTotal) {
        return repositories;
      }
      if (
        parsed.repositories.length === 0 ||
        repositories.length > expectedTotal
      ) {
        throw new Error(
          `GitHub inventory ended after ${repositories.length} of ` +
            `${expectedTotal} repositories.`,
        );
      }
    }
  }

  private async getDefaultBranchHead(
    token: string,
    repository: InstallationRepository,
  ): Promise<string> {
    const [owner, name] = repository.full_name.split("/");
    if (!owner || !name) {
      throw new Error(
        `GitHub repository name ${repository.full_name} is invalid.`,
      );
    }
    const requestPath =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
      `/git/ref/heads/${encodeURIComponent(repository.default_branch)}`;
    const body = await this.getJson(token, requestPath);
    return gitReferenceSchema.parse(body).object.sha;
  }

  private async getJson(token: string, requestPath: string): Promise<unknown> {
    const url = new URL(requestPath, this.apiBaseUrl);
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "documentation-drift-control-plane",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    if (!response.ok) {
      throw new GitHubControlPlaneRequestError(
        `${url.pathname}${url.search}`,
        response.status,
      );
    }
    return response.json();
  }
}

/**
 * Creates an app-scoped token provider backed by Vercel Connect.
 *
 * @returns A provider suitable for `GitHubControlPlaneClient`.
 */
export function createGitHubAppAccessTokenProvider(
  connectorId: string,
): GitHubAccessTokenProvider {
  if (connectorId.trim().length === 0) {
    throw new Error("A Vercel Connect GitHub connector ID is required.");
  }
  return () =>
    getToken(connectorId, {
      subject: { type: "app" },
    });
}

function validateApiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? "https://api.github.com/");
  if (url.protocol !== "https:") {
    throw new Error("GitHub API base URL must use HTTPS.");
  }
  return url;
}

function validateConcurrency(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_HEAD_REQUEST_CONCURRENCY
  ) {
    throw new RangeError(
      `GitHub head request concurrency must be between 1 and ` +
        `${MAX_HEAD_REQUEST_CONCURRENCY}.`,
    );
  }
  return value;
}

async function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      results[currentIndex] = await mapper(values[currentIndex]!);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}
