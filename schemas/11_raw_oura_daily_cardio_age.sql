-- raw_oura_daily_cardio_age — Oura v2 /usercollection/daily_cardiovascular_age
-- Natural key: (subject_id, day).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_daily_cardio_age (
  subject_id          INT64    NOT NULL,
  day                 DATE     NOT NULL,
  vascular_age_years  INT64,
  pulse_wave_velocity FLOAT64,        -- m/s
  source              STRING   NOT NULL,
  source_id           STRING,
  raw_json            JSON,
  ingested_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Daily cardiovascular age + pulse-wave velocity from Oura. Cornerstone Phase 1.");
