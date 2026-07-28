import { createHash } from "node:crypto";

import { z } from "zod";

const shaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    "Repository paths must be relative and cannot traverse directories.",
  );

const implementationReferenceSchema = z
  .object({
    path: repositoryPathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    symbol: z.string().min(1).max(256).optional(),
  })
  .refine(
    ({ startLine, endLine }) =>
      endLine === undefined ||
      (startLine !== undefined && endLine >= startLine),
    "An end line requires an earlier or equal start line.",
  );

const repositoryDocumentationSchema = z.object({
  kind: z.literal("repository"),
  path: repositoryPathSchema,
});

const confluenceDocumentationSchema = z.object({
  kind: z.literal("confluence"),
  siteId: z.string().min(1).max(256),
  pageId: z.string().regex(/^\d+$/),
  version: z.number().int().positive(),
  bodyHash: digestSchema,
});

const repositoryProposalTargetSchema = repositoryDocumentationSchema;
const confluenceProposalTargetSchema = confluenceDocumentationSchema;

const repositoryPatchSchema = z.object({
  kind: z.literal("repository-file-replacement"),
  content: z.string().max(1_000_000),
});

const confluencePatchSchema = z.object({
  kind: z.literal("confluence-section-replacement"),
  sectionId: z.string().min(1).max(512),
  baselineSectionHash: digestSchema,
  replacementStorageValue: z.string().max(1_000_000),
});

/** Model input for one immutable factual evidence claim. */
export const recordDriftEvidenceInputSchema = z.object({
  claim: z.string().min(1).max(4_000),
  implementationReferences: z
    .array(implementationReferenceSchema)
    .min(1)
    .max(100),
  documentation: z.discriminatedUnion("kind", [
    repositoryDocumentationSchema,
    confluenceDocumentationSchema,
  ]),
  confidenceReasons: z.array(z.string().min(1).max(1_000)).min(1).max(20),
});

/** Model input for one immutable, evidence-backed target proposal. */
export const changeProposalInputSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      repositoryProposalTargetSchema,
      confluenceProposalTargetSchema,
    ]),
    patch: z.discriminatedUnion("kind", [
      repositoryPatchSchema,
      confluencePatchSchema,
    ]),
    evidenceClaimIds: z.array(z.uuid()).min(1).max(100),
  })
  .superRefine(({ target, patch, evidenceClaimIds }, context) => {
    const matches =
      (target.kind === "repository" &&
        patch.kind === "repository-file-replacement") ||
      (target.kind === "confluence" &&
        patch.kind === "confluence-section-replacement");
    if (!matches) {
      context.addIssue({
        code: "custom",
        message: "Proposal patch format must match its target kind.",
      });
    }
    if (new Set(evidenceClaimIds).size !== evidenceClaimIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceClaimIds"],
        message: "Proposal evidence claim IDs must be unique.",
      });
    }
  });

/** Model input for the terminal outcome of the assigned review job. */
export const completeReviewJobInputSchema = z.object({
  outcome: z.enum([
    "no-change",
    "in-sync",
    "proposal-created",
    "incomplete",
  ]),
  summary: z.string().min(1).max(4_000),
});

/** Persisted evidence record returned to the active review session. */
export const evidenceClaimRecordSchema =
  recordDriftEvidenceInputSchema.extend({
    id: z.uuid(),
    reviewJobId: z.uuid(),
    digest: digestSchema,
    implementationSha: shaSchema,
  });

/** Persisted proposal record returned to the active review session. */
export const changeProposalRecordSchema = changeProposalInputSchema.extend({
  id: z.uuid(),
  reviewJobId: z.uuid(),
  digest: digestSchema,
  repositoryBaselineSha: shaSchema.nullable(),
});

/** Persisted terminal review result returned to the active session. */
export const completedReviewJobSchema = completeReviewJobInputSchema.extend({
  reviewJobId: z.uuid(),
  headSha: shaSchema,
  completedAt: z.iso.datetime(),
  cursorAdvanced: z.boolean(),
});

export type RecordDriftEvidenceInput = z.infer<
  typeof recordDriftEvidenceInputSchema
>;
export type EvidenceClaimRecord = z.infer<
  typeof evidenceClaimRecordSchema
>;
export type ChangeProposalInput = z.infer<
  typeof changeProposalInputSchema
>;
export type ChangeProposalRecord = z.infer<
  typeof changeProposalRecordSchema
>;
export type CompleteReviewJobInput = z.infer<
  typeof completeReviewJobInputSchema
>;
export type CompletedReviewJob = z.infer<
  typeof completedReviewJobSchema
>;

/**
 * Builds the canonical digest for one job-bound evidence claim.
 *
 * @returns A versioned SHA-256 digest including the reviewed implementation SHA.
 */
export function buildEvidenceClaimDigest(
  reviewJobId: string,
  implementationSha: string,
  input: RecordDriftEvidenceInput,
): string {
  return digest([
    "evidence-claim-v1",
    reviewJobId,
    implementationSha,
    input,
  ]);
}

/**
 * Builds the canonical digest for an immutable proposal.
 *
 * Evidence identifiers are sorted because their input order has no semantic
 * meaning. The reviewed repository SHA remains part of every target baseline.
 *
 * @returns A versioned SHA-256 proposal digest.
 */
export function buildChangeProposalDigest(
  reviewJobId: string,
  repositoryBaselineSha: string,
  input: ChangeProposalInput,
): string {
  return digest([
    "change-proposal-v1",
    reviewJobId,
    repositoryBaselineSha,
    {
      ...input,
      evidenceClaimIds: [...input.evidenceClaimIds].sort(),
    },
  ]);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalJson(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
