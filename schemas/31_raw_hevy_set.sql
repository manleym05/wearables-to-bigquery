-- raw_hevy_set — Hevy sets, one row per (workout, exercise, set).
-- Natural key: (subject_id, workout_id, exercise_idx, set_idx).
-- day denormalized from parent workout for partition pruning.
-- exercise_title denormalized for query convenience (joinable to raw_hevy_exercise_template via exercise_template_id).

CREATE TABLE IF NOT EXISTS life_ops.raw_hevy_set (
  subject_id           INT64    NOT NULL,
  workout_id           STRING   NOT NULL,
  exercise_idx         INT64    NOT NULL,          -- 0-based exercise position within the workout
  set_idx              INT64    NOT NULL,          -- 0-based set position within the exercise
  day                  DATE     NOT NULL,
  exercise_template_id STRING   NOT NULL,
  exercise_title       STRING,                     -- denormalized
  exercise_notes       STRING,
  supersets_id         INT64,                      -- nullable; same id = superset group
  set_type             STRING,                     -- 'normal' | 'warmup' | 'drop' | 'failure'
  weight_kg            FLOAT64,
  weight_lb            FLOAT64,
  reps                 INT64,
  distance_m           FLOAT64,                    -- non-null for distance-typed exercises (treadmill, etc.)
  duration_s           INT64,                      -- non-null for duration-typed exercises (planks, etc.)
  rpe                  FLOAT64,
  custom_metric        FLOAT64,
  volume_kg            FLOAT64,                    -- weight_kg * reps (precomputed for analytics)
  source               STRING   NOT NULL,
  raw_json             JSON,
  ingested_at          TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, workout_id, exercise_idx, set_idx) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id, exercise_template_id
OPTIONS (description = "Hevy sets (per-set detail with RPE, weight, reps). Cornerstone Phase 1.");
