-- raw_withings_activity — Withings /v2/measure?action=getactivity (one row per day).
-- Natural key: (subject_id, day).

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_activity (
  subject_id      INT64    NOT NULL,
  day             DATE     NOT NULL,
  timezone        STRING,
  device_id_hash  STRING,
  is_tracker      BOOL,
  steps           INT64,
  distance_m      FLOAT64,
  elevation_m     FLOAT64,
  soft_s          INT64,
  moderate_s      INT64,
  intense_s       INT64,
  active_s        INT64,
  calories        FLOAT64,
  total_calories  FLOAT64,
  hr_avg_bpm      FLOAT64,
  hr_min_bpm      FLOAT64,
  hr_max_bpm      FLOAT64,
  hr_zone_0_s     INT64,
  hr_zone_1_s     INT64,
  hr_zone_2_s     INT64,
  hr_zone_3_s     INT64,
  source          STRING   NOT NULL,
  raw_json        JSON,
  ingested_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Withings daily activity (steps, distance, HR zones). Cornerstone Phase 1.");
