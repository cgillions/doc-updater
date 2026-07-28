#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: ./local-session-detail.sh" >&2
  echo "Reports detail for the latest review job in the local Postgres database." >&2
  exit 64
fi

docker exec -i doc-updater-postgres \
  psql -X -Aqt -U doc_updater -d doc_updater \
    -v ON_ERROR_STOP=1 \
    -P pager=off \
    -P null='(null)' <<'SQL'
CREATE TEMP TABLE latest_review_job AS
SELECT *
FROM review_jobs
ORDER BY created_at DESC, id DESC
LIMIT 1;

SELECT CASE
  WHEN EXISTS (SELECT 1 FROM latest_review_job)
    THEN 'Latest review job'
  ELSE 'No review jobs found.'
END;

SELECT format(
  E'\n  id: %s\n  status: %s\n  mode: %s\n  outcome: %s\n  outcome_summary:\n    %s',
  id,
  status,
  mode,
  COALESCE(outcome::text, '(null)'),
  regexp_replace(COALESCE(outcome_summary, '(null)'), E'\n', E'\n    ', 'g')
)
FROM latest_review_job;

SELECT E'\nRepository';

SELECT format(
  E'\n  repository_full_name: %s\n  roadie_scope_status: %s\n  slack_channel_id: %s',
  repositories.repository_full_name,
  repositories.roadie_scope_status,
  COALESCE(repositories.slack_channel_id, '(null)')
)
FROM repository_registry AS repositories
INNER JOIN latest_review_job AS latest_job
  ON latest_job.repository_id = repositories.id
UNION ALL
SELECT E'\n  No repository found for the latest review job.'
WHERE EXISTS (SELECT 1 FROM latest_review_job)
  AND NOT EXISTS (
    SELECT 1
    FROM repository_registry AS repositories
    INNER JOIN latest_review_job AS latest_job
      ON latest_job.repository_id = repositories.id
  );

SELECT E'\nEvidence claims';

WITH scoped_evidence AS (
  SELECT evidence.review_job_id,
         evidence.claim_text,
         evidence.created_at,
         evidence.id
  FROM evidence_claims AS evidence
  INNER JOIN latest_review_job AS latest_job
    ON latest_job.id = evidence.review_job_id
)
SELECT format(
  E'\n  Claim %s\n  review_job_id: %s\n  claim_text:\n    %s',
  row_number() OVER (ORDER BY created_at DESC, id DESC),
  review_job_id,
  regexp_replace(claim_text, E'\n', E'\n    ', 'g')
)
FROM scoped_evidence
UNION ALL
SELECT E'\n  No evidence claims found for the latest review job.'
WHERE EXISTS (SELECT 1 FROM latest_review_job)
  AND NOT EXISTS (SELECT 1 FROM scoped_evidence)
ORDER BY 1;

SELECT E'\nChange proposals';

WITH scoped_proposals AS (
  SELECT proposals.review_job_id,
         proposals.target_kind,
         proposals.target,
         proposals.created_at,
         proposals.id
  FROM change_proposals AS proposals
  INNER JOIN latest_review_job AS latest_job
    ON latest_job.id = proposals.review_job_id
)
SELECT format(
  E'\n  Proposal %s\n  review_job_id: %s\n  target_kind: %s\n  target:\n    %s',
  row_number() OVER (ORDER BY created_at DESC, id DESC),
  review_job_id,
  target_kind,
  regexp_replace(jsonb_pretty(target), E'\n', E'\n    ', 'g')
)
FROM scoped_proposals
UNION ALL
SELECT E'\n  No change proposals found for the latest review job.'
WHERE EXISTS (SELECT 1 FROM latest_review_job)
  AND NOT EXISTS (SELECT 1 FROM scoped_proposals)
ORDER BY 1;
SQL
