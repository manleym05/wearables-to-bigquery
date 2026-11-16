-- raw_oura_rest_mode_period — Oura v2 /usercollection/rest_mode_period
-- Periods when ring was in rest mode (illness, injury, recovery). Episodes carry tags.
-- Natural key: (subject_id, period_id).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_rest_mode_period (
  subject_id     INT64    NOT NULL,
  start_day      DATE     NOT NULL,
  period_id      STRING   NOT NULL,
  end_day        DATE,
  start_time     TIMESTAMP,
  end_time       TIMESTAMP,
  episodes_json  JSON,                  -- array of {tags: [...], timestamp}
  source         STRING   NOT NULL,
  raw_json       JSON,
  ingested_at    TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, period_id) NOT ENFORCED
)
PARTITION BY start_day
CLUSTER BY subject_id
OPTIONS (description = "Oura rest-mode periods (illness/injury/recovery). Cornerstone Phase 1.");
