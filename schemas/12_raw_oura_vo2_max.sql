-- raw_oura_vo2_max — Oura v2 /usercollection/vO2_max
-- Natural key: (subject_id, day). Sparse (measurements every few weeks).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_vo2_max (
  subject_id    INT64    NOT NULL,
  day           DATE     NOT NULL,
  measured_at   TIMESTAMP,
  vo2_max       FLOAT64,
  source        STRING   NOT NULL,
  source_id     STRING,
  raw_json      JSON,
  ingested_at   TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Oura VO2 max estimates (sparse, weekly-ish). Cornerstone Phase 1.");
