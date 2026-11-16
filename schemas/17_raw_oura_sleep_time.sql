-- raw_oura_sleep_time — Oura v2 /usercollection/sleep_time
-- Oura's recommended optimal bedtime per day.
-- Natural key: (subject_id, day). Often NULL until enough nights of data.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_sleep_time (
  subject_id            INT64    NOT NULL,
  day                   DATE     NOT NULL,
  optimal_bedtime_json  JSON,             -- {start_offset, end_offset, day_tz} or NULL
  recommendation        STRING,           -- 'earlier' | 'later' | 'maintain' | etc.
  status                STRING,           -- 'not_enough_nights' | 'recommended' | etc.
  source                STRING   NOT NULL,
  source_id             STRING,
  raw_json              JSON,
  ingested_at           TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Oura recommended optimal bedtime. Cornerstone Phase 1.");
