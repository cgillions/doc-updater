import { z } from "zod";

const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** One implementation path changed within an incremental review range. */
export const changedRepositoryFileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.string().min(1),
  patch: z.string().min(1).optional(),
});

/** One ordered commit included in an incremental review range. */
export const repositoryReviewCommitSchema = z.object({
  sha: gitShaSchema,
  message: z.string(),
  parentShas: z.array(gitShaSchema),
});

/** Immutable, baseline-bound repository inputs available to one review. */
export const repositoryReviewScopeSchema = z.object({
  mode: z.enum(["INCREMENTAL", "RECONCILIATION"]),
  baseSha: gitShaSchema.nullable(),
  headSha: gitShaSchema,
  commits: z.array(repositoryReviewCommitSchema),
  changedFiles: z.array(changedRepositoryFileSchema),
  documentationFiles: z.array(z.string().min(1)),
});

/** UTF-8 repository content read at an assigned review revision. */
export const repositoryFileContentSchema = z.object({
  path: z.string().min(1),
  revision: z.enum(["base", "head"]),
  gitSha: gitShaSchema,
  byteLength: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string(),
});

/** Model input for a file read within the assigned repository and SHAs. */
export const repositoryFileRequestSchema = z.object({
  path: z.string().min(1).max(1_024),
  revision: z.enum(["base", "head"]),
});

/** Model input for bounded text search within the assigned repository. */
export const repositorySearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(120),
  revision: z.enum(["base", "head"]),
  maxResults: z.number().int().min(1).max(20).default(10),
});

/** One bounded repository search result. */
export const repositorySearchResultSchema = z.object({
  path: z.string().min(1),
  lineNumber: z.number().int().positive(),
  snippet: z.string().min(1).max(500),
});

/** Bounded repository search output visible to the model. */
export const repositorySearchResponseSchema = z.object({
  query: z.string().min(1),
  revision: z.enum(["base", "head"]),
  gitSha: gitShaSchema,
  results: z.array(repositorySearchResultSchema).max(20),
  searchedFileCount: z.number().int().nonnegative(),
  skippedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  guidance: z.string().min(1),
});

export type RepositoryReviewScope = z.infer<
  typeof repositoryReviewScopeSchema
>;
export type RepositoryFileContent = z.infer<
  typeof repositoryFileContentSchema
>;
export type RepositoryFileRequest = z.infer<
  typeof repositoryFileRequestSchema
>;
export type RepositorySearchRequest = z.infer<
  typeof repositorySearchRequestSchema
>;
export type RepositorySearchResponse = z.infer<
  typeof repositorySearchResponseSchema
>;
