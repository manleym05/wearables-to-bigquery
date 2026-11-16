-- raw_oura_daily_spo2 — Oura v2 /usercollection/daily_spo2
-- Natural key: (subject_id, day). Oura sometimes returns >1/day; MERGE source-dedupes.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_daily_spo2 (
  subject_id                  INT64    NOT NULL,
  day                         DATE     NOT NULL,
  spo2_avg_pct                FLOAT64,        -- spo2_percentage.average
  breathing_disturbance_index INT64,
  source                      STRING   NOT NULL,
  source_id                   STRING,
  raw_json                    JSON,
  ingested_at                 TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Daily SpO2 + breathing disturbance index from Oura. Cornerstone Phase 1.");
