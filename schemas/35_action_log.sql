-- action_log — audit table for every outbound *action* component (writes / side-effects).
-- First writer: cornerstone-hevy-push (Hevy routine create/update).
-- Future writers: grocery ordering, calendar_write, any agent action that mutates an external system.
--
-- Conventions:
--  * ts             = write moment (UTC). Hot column; we filter on it for recency.
--  * action_type    = short slug, namespaced. e.g. "hevy_push_routine", "grocery_order_submit".
--  * subject_id     = whose action (1 = the owner), per the dataset-wide convention.
--  * target_date    = the local-date the action *targets* (e.g. workout date), if applicable.
--  * gate           = HRV/training gate at action time: GREEN | YELLOW | AMBER | RED | null
--  * status         = "success" | "skipped" | "error" | "validation_failed"
--  * external_id    = vendor-side ID returned (Hevy routine_id, Instacart order_id, …)
--  * idempotency_key= client-provided key; the (subject_id, action_type, idempotency_key) tuple
--                     is how repeat callers find the prior result. Uniqueness *not enforced* —
--                     callers MUST query latest success and decide create-vs-update before posting.
--  * payload_json   = the request body actually sent (post-gate-enforcement, post-sanitization).
--  * response_json  = the vendor response (or error payload).
--  * payload_hash   = SHA-256 hex of payload_json — lets us detect "same payload re-pushed" without
--                     re-diffing the JSON. Useful for action-level dedup and audit.
--  * error          = human-readable error message when status != "success".
--  * worker         = which Cornerstone worker wrote the row (e.g. "cornerstone-hevy-push@1.0").
--
-- Querying:
--   -- last successful Hevy push for a given idempotency key:
--   SELECT * FROM life_ops.action_log
--   WHERE subject_id = 1
--     AND action_type = 'hevy_push_routine'
--     AND idempotency_key = 'plan-2026-05-26-day2-lower'
--     AND status = 'success'
--   ORDER BY ts DESC LIMIT 1;
--
--   -- recent actions across all types for the dashboard:
--   SELECT ts, action_type, status, target_date, gate, error
--   FROM life_ops.action_log
--   WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
--   ORDER BY ts DESC;

CREATE TABLE IF NOT EXISTS life_ops.action_log (
  ts               TIMESTAMP NOT NULL,
  action_type      STRING    NOT NULL,
  subject_id       INT64     NOT NULL,
  target_date      DATE,
  gate             STRING,
  status           STRING    NOT NULL,
  external_id      STRING,
  idempotency_key  STRING,
  payload_json     JSON,
  response_json    JSON,
  payload_hash     STRING,
  http_status      INT64,
  error            STRING,
  worker           STRING,
  raw_request_id   STRING                                -- optional client correlation id
)
PARTITION BY DATE(ts)
CLUSTER BY subject_id, action_type, idempotency_key
OPTIONS (description = "Audit log for outbound action components (Hevy push, grocery order, …). Cornerstone Phase 1.");
