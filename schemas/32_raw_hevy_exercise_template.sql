-- raw_hevy_exercise_template — Hevy v1 /exercise_templates (exercise catalog).
-- Mix of Hevy's stock catalog (is_custom=false, universal) and user's custom exercises
-- (is_custom=true, per-account). Refreshed every cron tick.
-- Natural key: (subject_id, exercise_template_id).

CREATE TABLE IF NOT EXISTS life_ops.raw_hevy_exercise_template (
  subject_id                    INT64    NOT NULL,
  exercise_template_id          STRING   NOT NULL,
  title                         STRING,
  type                          STRING,             -- 'weight_reps' | 'weight_distance' | 'reps_only' | 'distance_duration' | etc.
  primary_muscle_group          STRING,
  secondary_muscle_groups_json  JSON,               -- array of strings
  equipment                     STRING,
  is_custom                     BOOL,
  source                        STRING   NOT NULL,
  raw_json                      JSON,
  ingested_at                   TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, exercise_template_id) NOT ENFORCED
)
CLUSTER BY subject_id, exercise_template_id
OPTIONS (description = "Hevy exercise template catalog (stock + custom). Cornerstone Phase 1.");
