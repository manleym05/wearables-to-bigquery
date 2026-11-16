-- raw_oura_daily_stress — Oura v2 /usercollection/daily_stress
-- Natural key: (subject_id, day). Source-dedupe in MERGE if Oura returns >1/day.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_daily_stress (
  subject_id     INT64    NOT NULL,
  day            DATE     NOT NULL,
  stress_high_s  INT64,                -- seconds spent in high-stress state during day
  recovery_high_s INT64,               -- seconds spent in high-recovery state during day
  day_summary    STRING,               -- 'restored' | 'normal' | 'stressful' | etc.
  source         STRING   NOT NULL,    -- 'oura_api'
  source_id      STRING,
  raw_json       JSON,
  ingested_at    TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Daily stress/recovery time totals from Oura. Cornerstone Phase 1.");
