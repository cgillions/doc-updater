CREATE TABLE "confluence_page_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "body_storage_value" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "confluence_page_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "confluence_page_snapshots_version_positive"
    CHECK ("version" > 0),
  CONSTRAINT "confluence_page_snapshots_page_id_format"
    CHECK ("page_id" ~ '^[0-9]+$'),
  CONSTRAINT "confluence_page_snapshots_body_hash_format"
    CHECK ("body_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "review_job_confluence_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_job_id" UUID NOT NULL,
  "site_id" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "snapshot_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_job_confluence_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_job_confluence_candidates_page_id_format"
    CHECK ("page_id" ~ '^[0-9]+$')
);

CREATE UNIQUE INDEX "confluence_page_snapshots_site_id_page_id_version_key"
  ON "confluence_page_snapshots"("site_id", "page_id", "version");
CREATE INDEX "confluence_page_snapshots_site_id_page_id_fetched_at_idx"
  ON "confluence_page_snapshots"("site_id", "page_id", "fetched_at");
CREATE UNIQUE INDEX "review_job_confluence_candidates_job_site_page_key"
  ON "review_job_confluence_candidates"("review_job_id", "site_id", "page_id");
CREATE INDEX "review_job_confluence_candidates_review_job_id_created_at_idx"
  ON "review_job_confluence_candidates"("review_job_id", "created_at");
CREATE INDEX "review_job_confluence_candidates_snapshot_id_idx"
  ON "review_job_confluence_candidates"("snapshot_id");

ALTER TABLE "review_job_confluence_candidates"
  ADD CONSTRAINT "review_job_confluence_candidates_review_job_id_fkey"
    FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_job_confluence_candidates_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "confluence_page_snapshots"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER confluence_page_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "confluence_page_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_review_record_mutation();
