-- raw_withings_workout — Withings /v2/measure?action=getworkouts (per-workout).
-- Natural key: (subject_id, workout_id).

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_workout (
  subject_id            INT64    NOT NULL,
  workout_id            INT64    NOT NULL,            -- Withings id (fallback: startdate epoch)
  day                   DATE     NOT NULL,
  category              INT64,                        -- 1=Walk, 2=Run, 6=Bike, 16=LiftWeights, 28=Yoga, ...
  attrib                INT64,
  startdate             TIMESTAMP,
  enddate               TIMESTAMP,
  effective_duration_s  INT64,
  pause_duration_s      INT64,
  algo_pause_duration_s INT64,
  intensity             INT64,
  calories              FLOAT64,
  manual_calories       FLOAT64,
  steps                 INT64,
  distance_m            FLOAT64,
  manual_distance_m     FLOAT64,
  elevation_m           FLOAT64,
  ascent_m              FLOAT64,
  descent_m             FLOAT64,
  spo2_avg_pct          FLOAT64,
  hr_avg_bpm            FLOAT64,
  hr_min_bpm            FLOAT64,
  hr_max_bpm            FLOAT64,
  hr_zone_0_s           INT64,
  hr_zone_1_s           INT64,
  hr_zone_2_s           INT64,
  hr_zone_3_s           INT64,
  device_id             STRING,
  model                 INT64,
  model_id              INT64,
  timezone              STRING,
  source                STRING   NOT NULL,
  raw_json              JSON,
  ingested_at           TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, workout_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Withings workouts (Steel HR, ScanWatch, etc.). Per-workout HR zones, distance, calories. Cornerstone Phase 1.");
