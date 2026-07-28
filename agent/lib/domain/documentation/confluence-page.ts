import { createHash } from "node:crypto";

import { z } from "zod";

import {
  behaviorComparisonSchema,
  implementationReferenceSchema,
} from "../reviews/review-records.ts";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Trusted Confluence page coordinates resolved from Roadie. */
export interface ConfluencePageTarget {
  siteId: string;
  pageId: string;
}

/** Native Confluence storage-format page returned by the REST client. */
export interface ConfluencePage {
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
}

export const searchDocumentIndexInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(10),
});

export const confluenceCandidateSummarySchema = z.object({
  candidateId: z.uuid(),
  label: z.string().min(1),
  title: z.string(),
  version: z.number().int().positive(),
  excerpt: z.string(),
  provenance: z.array(
    z.object({
      entityRef: z.string().min(1),
      title: z.string().min(1).optional(),
    }),
  ),
});

export const searchDocumentIndexResultSchema = z.object({
  candidates: z.array(confluenceCandidateSummarySchema),
});

export const getDocumentCandidateInputSchema = z.object({
  candidateId: z.uuid(),
});

export const confluenceDocumentCandidateSchema = z.object({
  candidateId: z.uuid(),
  title: z.string(),
  version: z.number().int().positive(),
  bodyHash: digestSchema,
  bodyStorageValue: z.string().max(1_000_000),
});

export const recordConfluenceEvidenceInputSchema = z.object({
  candidateId: z.uuid(),
  claim: z.string().min(1).max(4_000),
  implementationReferences: z
    .array(implementationReferenceSchema)
    .min(1)
    .max(100),
  behaviorComparisons: z
    .array(behaviorComparisonSchema)
    .min(1)
    .max(100),
  confidenceReasons: z.array(z.string().min(1).max(1_000)).min(1).max(20),
});

export const createConfluenceProposalInputSchema = z.object({
  candidateId: z.uuid(),
  baselineStorageValue: z.string().min(1).max(1_000_000),
  replacementStorageValue: z.string().max(1_000_000),
  evidenceClaimIds: z.array(z.uuid()).min(1).max(100),
});

export type SearchDocumentIndexInput = z.infer<
  typeof searchDocumentIndexInputSchema
>;
export type ConfluenceCandidateSummary = z.infer<
  typeof confluenceCandidateSummarySchema
>;
export type ConfluenceDocumentCandidate = z.infer<
  typeof confluenceDocumentCandidateSchema
>;
export type RecordConfluenceEvidenceInput = z.infer<
  typeof recordConfluenceEvidenceInputSchema
>;
export type CreateConfluenceProposalInput = z.infer<
  typeof createConfluenceProposalInputSchema
>;

export function hashConfluenceBody(storageValue: string): string {
  return hash(storageValue);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
