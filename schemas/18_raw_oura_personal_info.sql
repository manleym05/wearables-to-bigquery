-- raw_oura_personal_info — Oura v2 /usercollection/personal_info
-- Single-row table keyed only on subject_id. Refreshed every cron tick (cheap), MERGEd on PK.
-- Tracks: age, weight_kg, height_m, biological_sex, email. Rarely changes.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_personal_info (
  subject_id      INT64    NOT NULL,
  oura_user_id    STRING,
  age             INT64,
  weight_kg       FLOAT64,
  height_m        FLOAT64,
  biological_sex  STRING,
  email           STRING,
  source          STRING   NOT NULL,
  raw_json        JSON,
  ingested_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id) NOT ENFORCED
)
CLUSTER BY subject_id
OPTIONS (description = "Oura personal_info snapshot. Single row per subject, last-write-wins. Cornerstone Phase 1.");
