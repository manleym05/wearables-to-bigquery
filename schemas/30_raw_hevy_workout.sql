-- raw_hevy_workout — Hevy v1 /workouts (one row per workout session).
-- Natural key: (subject_id, workout_id). day = local wake-date of start_time.
-- Derived columns (set_count, total_volume_kg, total_reps, avg_rpe) computed in Worker
-- from the nested exercises[].sets[] structure before MERGE. Warmup sets excluded from volume.

CREATE TABLE IF NOT EXISTS life_ops.raw_hevy_workout (
  subject_id       INT64    NOT NULL,
  workout_id       STRING   NOT NULL,           -- Hevy workout uuid
  day              DATE     NOT NULL,           -- local date of start_at
  title            STRING,
  description      STRING,
  start_at         TIMESTAMP NOT NULL,
  end_at           TIMESTAMP,
  duration_min     INT64,
  exercise_count   INT64,
  set_count        INT64,                       -- excludes warmups
  total_volume_kg  FLOAT64,                     -- sum(weight_kg * reps) across non-warmup sets
  total_volume_lb  FLOAT64,
  total_reps       INT64,
  avg_rpe          FLOAT64,                     -- mean RPE across sets where RPE was logged
  created_at       TIMESTAMP,
  updated_at       TIMESTAMP,
  source           STRING   NOT NULL,           -- 'hevy_api'
  raw_json         JSON,
  ingested_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, workout_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Hevy workout sessions. Cornerstone Phase 1.");
