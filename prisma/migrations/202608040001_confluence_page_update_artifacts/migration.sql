CREATE TABLE "confluence_page_update_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repository_id" UUID NOT NULL,
    "review_job_id" UUID NOT NULL,
    "change_proposal_id" UUID NOT NULL,
    "proposal_digest" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "baseline_version" INTEGER NOT NULL,
    "baseline_body_hash" TEXT NOT NULL,
    "published_version" INTEGER NOT NULL,
    "page_url" TEXT NOT NULL,
    "history_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confluence_page_update_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "confluence_page_update_artifacts_baseline_version_positive"
      CHECK ("baseline_version" > 0),
    CONSTRAINT "confluence_page_update_artifacts_published_version_next"
      CHECK ("published_version" = "baseline_version" + 1),
    CONSTRAINT "confluence_page_update_artifacts_page_id_format"
      CHECK ("page_id" ~ '^[0-9]+$'),
    CONSTRAINT "confluence_page_update_artifacts_body_hash_format"
      CHECK ("baseline_body_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "confluence_page_update_artifacts_change_proposal_id_key"
ON "confluence_page_update_artifacts"("change_proposal_id");

CREATE UNIQUE INDEX "confluence_page_update_artifacts_proposal_digest_key"
ON "confluence_page_update_artifacts"("proposal_digest");

CREATE INDEX "confluence_page_update_artifacts_site_id_page_id_created_at_idx"
ON "confluence_page_update_artifacts"("site_id", "page_id", "created_at");

CREATE INDEX "confluence_page_update_artifacts_repository_id_created_at_idx"
ON "confluence_page_update_artifacts"("repository_id", "created_at");

CREATE INDEX "confluence_page_update_artifacts_review_job_id_created_at_idx"
ON "confluence_page_update_artifacts"("review_job_id", "created_at");

ALTER TABLE "confluence_page_update_artifacts"
ADD CONSTRAINT "confluence_page_update_artifacts_repository_id_fkey"
FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "confluence_page_update_artifacts"
ADD CONSTRAINT "confluence_page_update_artifacts_review_job_id_fkey"
FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "confluence_page_update_artifacts"
ADD CONSTRAINT "confluence_page_update_artifacts_change_proposal_id_fkey"
FOREIGN KEY ("change_proposal_id") REFERENCES "change_proposals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER confluence_page_update_artifacts_immutable
BEFORE UPDATE OR DELETE ON "confluence_page_update_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_review_record_mutation();
