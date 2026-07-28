import { z } from "zod";

const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** One implementation path changed within an incremental review range. */
export const changedRepositoryFileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.string().min(1),
});

/** Immutable, baseline-bound repository inputs available to one review. */
export const repositoryReviewScopeSchema = z.object({
  mode: z.enum(["INCREMENTAL", "RECONCILIATION"]),
  baseSha: gitShaSchema.nullable(),
  headSha: gitShaSchema,
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

export type RepositoryReviewScope = z.infer<
  typeof repositoryReviewScopeSchema
>;
export type RepositoryFileContent = z.infer<
  typeof repositoryFileContentSchema
>;
export type RepositoryFileRequest = z.infer<
  typeof repositoryFileRequestSchema
>;
