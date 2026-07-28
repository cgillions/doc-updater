CREATE TYPE "ReviewTargetKind" AS ENUM (
  'REPOSITORY',
  'CONFLUENCE'
);

CREATE TYPE "ReviewJobOutcome" AS ENUM (
  'NO_CHANGE',
  'IN_SYNC',
  'PROPOSAL_CREATED',
  'INCOMPLETE'
);

ALTER TABLE "review_jobs"
  ADD COLUMN "outcome" "ReviewJobOutcome",
  ADD COLUMN "outcome_summary" TEXT,
  ADD COLUMN "cursor_advanced_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "review_jobs_outcome_state_check"
    CHECK ("outcome" IS NULL OR "status" = 'COMPLETED'),
  ADD CONSTRAINT "review_jobs_cursor_outcome_check"
    CHECK (
      "cursor_advanced_at" IS NULL
      OR "outcome" IN ('NO_CHANGE', 'IN_SYNC', 'PROPOSAL_CREATED')
    );

CREATE TABLE "evidence_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "repository_id" UUID NOT NULL,
  "review_job_id" UUID NOT NULL,
  "digest" TEXT NOT NULL,
  "claim_text" TEXT NOT NULL,
  "implementation_sha" TEXT NOT NULL,
  "implementation_references" JSONB NOT NULL,
  "target_kind" "ReviewTargetKind" NOT NULL,
  "documentation" JSONB NOT NULL,
  "confidence_reasons" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_claims_claim_not_empty"
    CHECK (length("claim_text") > 0),
  CONSTRAINT "evidence_claims_sha_format"
    CHECK ("implementation_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT "evidence_claims_digest_format"
    CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "evidence_claims_references_array"
    CHECK (jsonb_typeof("implementation_references") = 'array'),
  CONSTRAINT "evidence_claims_documentation_object"
    CHECK (jsonb_typeof("documentation") = 'object'),
  CONSTRAINT "evidence_claims_confidence_array"
    CHECK (jsonb_typeof("confidence_reasons") = 'array')
);

CREATE TABLE "change_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "repository_id" UUID NOT NULL,
  "review_job_id" UUID NOT NULL,
  "digest" TEXT NOT NULL,
  "target_kind" "ReviewTargetKind" NOT NULL,
  "target" JSONB NOT NULL,
  "repository_baseline_sha" TEXT,
  "patch" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "change_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "change_proposals_digest_format"
    CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "change_proposals_target_object"
    CHECK (jsonb_typeof("target") = 'object'),
  CONSTRAINT "change_proposals_patch_object"
    CHECK (jsonb_typeof("patch") = 'object'),
  CONSTRAINT "change_proposals_baseline_consistency"
    CHECK (
      (
        "target_kind" = 'REPOSITORY'
        AND "repository_baseline_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
      )
      OR (
        "target_kind" = 'CONFLUENCE'
        AND "repository_baseline_sha" IS NULL
      )
    )
);

CREATE TABLE "change_proposal_evidence" (
  "change_proposal_id" UUID NOT NULL,
  "evidence_claim_id" UUID NOT NULL,
  CONSTRAINT "change_proposal_evidence_pkey"
    PRIMARY KEY ("change_proposal_id", "evidence_claim_id")
);

CREATE UNIQUE INDEX "evidence_claims_digest_key"
  ON "evidence_claims"("digest");
CREATE INDEX "evidence_claims_review_job_id_created_at_idx"
  ON "evidence_claims"("review_job_id", "created_at");
CREATE INDEX "evidence_claims_repository_id_created_at_idx"
  ON "evidence_claims"("repository_id", "created_at");
CREATE UNIQUE INDEX "change_proposals_digest_key"
  ON "change_proposals"("digest");
CREATE INDEX "change_proposals_review_job_id_created_at_idx"
  ON "change_proposals"("review_job_id", "created_at");
CREATE INDEX "change_proposals_repository_id_created_at_idx"
  ON "change_proposals"("repository_id", "created_at");
CREATE INDEX "change_proposal_evidence_evidence_claim_id_idx"
  ON "change_proposal_evidence"("evidence_claim_id");

ALTER TABLE "evidence_claims"
  ADD CONSTRAINT "evidence_claims_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_claims_review_job_id_fkey"
    FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "change_proposals"
  ADD CONSTRAINT "change_proposals_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "change_proposals_review_job_id_fkey"
    FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "change_proposal_evidence"
  ADD CONSTRAINT "change_proposal_evidence_change_proposal_id_fkey"
    FOREIGN KEY ("change_proposal_id") REFERENCES "change_proposals"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "change_proposal_evidence_evidence_claim_id_fkey"
    FOREIGN KEY ("evidence_claim_id") REFERENCES "evidence_claims"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_immutable_review_record_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_claims_immutable
  BEFORE UPDATE OR DELETE ON "evidence_claims"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_review_record_mutation();

CREATE TRIGGER change_proposals_immutable
  BEFORE UPDATE OR DELETE ON "change_proposals"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_review_record_mutation();
