#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: ./local-session-rollback.sh" >&2
  echo "Removes the latest review job and its local replay artifacts." >&2
  exit 64
fi

docker exec -i doc-updater-postgres \
  psql -X -Aqt -U doc_updater -d doc_updater \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -P null='(null)' <<'SQL'
BEGIN;

CREATE TEMP TABLE latest_review_job AS
SELECT *
FROM review_jobs
ORDER BY created_at DESC, id DESC
LIMIT 1;

CREATE TEMP TABLE latest_snapshot_ids AS
SELECT DISTINCT candidates.snapshot_id AS id
FROM review_job_confluence_candidates AS candidates
INNER JOIN latest_review_job AS latest_job
  ON latest_job.id = candidates.review_job_id
WHERE candidates.snapshot_id IS NOT NULL;

CREATE TEMP TABLE reset_counts (
  name text PRIMARY KEY,
  count integer NOT NULL
);

INSERT INTO reset_counts
SELECT 'latest_review_job', count(*)::integer
FROM latest_review_job;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM latest_review_job AS latest_job
    INNER JOIN repository_cursors AS cursors
      ON cursors.repository_id = latest_job.repository_id
    WHERE latest_job.cursor_advanced_at IS NOT NULL
      AND cursors.last_successfully_reviewed_sha IS DISTINCT FROM latest_job.head_sha
  ) THEN
    RAISE EXCEPTION 'Refusing to reset: repository cursor no longer points at the latest job head.';
  END IF;
END $$;

ALTER TABLE evidence_claims DISABLE TRIGGER USER;
ALTER TABLE change_proposals DISABLE TRIGGER USER;
ALTER TABLE confluence_page_snapshots DISABLE TRIGGER USER;

WITH deleted AS (
  DELETE FROM change_proposal_evidence AS links
  USING change_proposals AS proposals,
        latest_review_job AS latest_job
  WHERE links.change_proposal_id = proposals.id
    AND proposals.review_job_id = latest_job.id
  RETURNING links.change_proposal_id
)
INSERT INTO reset_counts
SELECT 'change_proposal_evidence', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM change_proposals AS proposals
  USING latest_review_job AS latest_job
  WHERE proposals.review_job_id = latest_job.id
  RETURNING proposals.id
)
INSERT INTO reset_counts
SELECT 'change_proposals', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM evidence_claims AS evidence
  USING latest_review_job AS latest_job
  WHERE evidence.review_job_id = latest_job.id
  RETURNING evidence.id
)
INSERT INTO reset_counts
SELECT 'evidence_claims', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM review_job_confluence_candidates AS candidates
  USING latest_review_job AS latest_job
  WHERE candidates.review_job_id = latest_job.id
  RETURNING candidates.id
)
INSERT INTO reset_counts
SELECT 'review_job_confluence_candidates', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM confluence_page_snapshots AS snapshots
  USING latest_snapshot_ids AS latest_snapshots
  WHERE snapshots.id = latest_snapshots.id
    AND NOT EXISTS (
      SELECT 1
      FROM review_job_confluence_candidates AS candidates
      WHERE candidates.snapshot_id = snapshots.id
    )
  RETURNING snapshots.id
)
INSERT INTO reset_counts
SELECT 'confluence_page_snapshots', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM audit_events AS events
  USING latest_review_job AS latest_job
  WHERE events.review_job_id = latest_job.id
  RETURNING events.id
)
INSERT INTO reset_counts
SELECT 'audit_events', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM repository_cursors AS cursors
  USING latest_review_job AS latest_job
  WHERE latest_job.cursor_advanced_at IS NOT NULL
    AND latest_job.base_sha IS NULL
    AND cursors.repository_id = latest_job.repository_id
  RETURNING cursors.repository_id
)
INSERT INTO reset_counts
SELECT 'repository_cursors_deleted', count(*)::integer
FROM deleted;

WITH updated AS (
  UPDATE repository_cursors AS cursors
  SET last_successfully_reviewed_sha = latest_job.base_sha,
      last_successfully_reviewed_at = latest_job.created_at,
      updated_at = CURRENT_TIMESTAMP
  FROM latest_review_job AS latest_job
  WHERE latest_job.cursor_advanced_at IS NOT NULL
    AND latest_job.base_sha IS NOT NULL
    AND cursors.repository_id = latest_job.repository_id
  RETURNING cursors.repository_id
)
INSERT INTO reset_counts
SELECT 'repository_cursors_rolled_back', count(*)::integer
FROM updated;

WITH deleted AS (
  DELETE FROM review_jobs AS jobs
  USING latest_review_job AS latest_job
  WHERE jobs.id = latest_job.id
  RETURNING jobs.id
)
INSERT INTO reset_counts
SELECT 'review_jobs', count(*)::integer
FROM deleted;

WITH deleted AS (
  DELETE FROM review_job_claim_invocations AS invocations
  USING latest_review_job AS latest_job
  WHERE invocations.id = latest_job.claim_invocation_id
    AND NOT EXISTS (
      SELECT 1
      FROM review_jobs AS jobs
      WHERE jobs.claim_invocation_id = invocations.id
    )
  RETURNING invocations.id
)
INSERT INTO reset_counts
SELECT 'review_job_claim_invocations', count(*)::integer
FROM deleted;

ALTER TABLE confluence_page_snapshots ENABLE TRIGGER USER;
ALTER TABLE change_proposals ENABLE TRIGGER USER;
ALTER TABLE evidence_claims ENABLE TRIGGER USER;

COMMIT;

SELECT CASE
  WHEN (SELECT count FROM reset_counts WHERE name = 'latest_review_job') = 0
    THEN 'No review jobs found.'
  ELSE 'Removed latest review job and replay artifacts.'
END;

SELECT format(
  E'\n  %s: %s',
  name,
  count
)
FROM reset_counts
ORDER BY name;
SQL
