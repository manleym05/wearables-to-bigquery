-- raw_oura_workout — Oura v2 /usercollection/workout
-- Natural key: (subject_id, workout_id). Multiple workouts/day possible.
-- NOTE: source field captures Oura's source ('manual', 'autodetected', 'strava', etc.) —
-- Strava-synced workouts may also appear in raw_strava_activities (Phase 1, separate Worker).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_workout (
  subject_id       INT64    NOT NULL,
  day              DATE     NOT NULL,
  workout_id       STRING   NOT NULL,
  activity         STRING,                 -- 'running' | 'walking' | 'cycling' | etc.
  intensity        STRING,                 -- 'easy' | 'moderate' | 'hard'
  start_datetime   TIMESTAMP,
  end_datetime     TIMESTAMP,
  calories         FLOAT64,
  distance_m       FLOAT64,
  label            STRING,
  oura_source      STRING,                 -- 'manual' | 'autodetected' | 'strava' | etc.
  source           STRING   NOT NULL,      -- 'oura_api' (this row's ingest path)
  raw_json         JSON,
  ingested_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, workout_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Workouts captured by Oura. Cornerstone Phase 1.");
