DROP INDEX "confluence_draft_artifacts_change_proposal_id_key";
DROP INDEX "confluence_draft_artifacts_proposal_digest_key";
DROP INDEX "confluence_draft_artifacts_site_id_page_id_key";

CREATE INDEX "confluence_draft_artifacts_change_proposal_id_idx"
  ON "confluence_draft_artifacts"("change_proposal_id");
CREATE INDEX "confluence_draft_artifacts_proposal_digest_idx"
  ON "confluence_draft_artifacts"("proposal_digest");
CREATE INDEX "confluence_draft_artifacts_site_id_page_id_created_at_idx"
  ON "confluence_draft_artifacts"("site_id", "page_id", "created_at");
