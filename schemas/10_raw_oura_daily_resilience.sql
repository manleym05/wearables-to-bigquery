-- raw_oura_daily_resilience — Oura v2 /usercollection/daily_resilience
-- Natural key: (subject_id, day).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_daily_resilience (
  subject_id           INT64    NOT NULL,
  day                  DATE     NOT NULL,
  level                STRING,           -- 'limited' | 'adequate' | 'solid' | 'strong' | 'exceptional'
  sleep_recovery       FLOAT64,          -- contributors.sleep_recovery
  daytime_recovery     FLOAT64,          -- contributors.daytime_recovery
  stress_contributor   FLOAT64,          -- contributors.stress
  source               STRING   NOT NULL,
  source_id            STRING,
  raw_json             JSON,
  ingested_at          TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Daily resilience level + contributors from Oura. Cornerstone Phase 1.");
