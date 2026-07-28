import { z } from "zod";

const documentationDeclarationSchema = z.object({
  kind: z.enum(["exact", "root"]),
  excludedPageIds: z.array(z.string().regex(/^\d+$/)),
  provenance: z.object({
    entityRef: z.string().min(1),
    title: z.string().min(1).optional(),
    url: z.url(),
  }),
});

const documentationTargetSchema = z.object({
  siteId: z.string().min(1),
  pageId: z.string().regex(/^\d+$/),
  declarations: z.array(documentationDeclarationSchema).min(1),
});

/** Validated context exposed for one active, session-bound review job. */
export const reviewJobContextSchema = z.object({
  reviewJobId: z.uuid(),
  mode: z.enum(["INCREMENTAL", "RECONCILIATION"]),
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .nullable(),
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  repository: z.object({
    id: z.uuid(),
    fullName: z.string().regex(/^[^/]+\/[^/]+$/),
    defaultBranch: z.string().min(1),
  }),
  roadie: z.object({
    componentRef: z.string().min(1),
    systemRef: z.string().min(1),
    ownerRef: z.string().min(1),
    slackChannelId: z.string().regex(/^[CG][A-Z0-9]{8,}$/),
    catalogRevision: z.string().min(1).nullable(),
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  documentationScope: z.array(documentationTargetSchema),
});

/** JSON-safe repository context returned by `load_review_job`. */
export type ReviewJobContext = z.infer<typeof reviewJobContextSchema>;
