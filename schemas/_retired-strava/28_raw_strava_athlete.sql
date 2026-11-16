-- raw_strava_athlete — Strava v3 /athlete (profile singleton).
-- Refreshed each cron tick; MERGE on subject_id (one row per subject).

CREATE TABLE IF NOT EXISTS life_ops.raw_strava_athlete (
  subject_id              INT64    NOT NULL,
  athlete_id              INT64    NOT NULL,
  username                STRING,
  firstname               STRING,
  lastname                STRING,
  city                    STRING,
  state                   STRING,
  country                 STRING,
  sex                     STRING,
  premium                 BOOL,
  summit                  BOOL,
  weight_kg               FLOAT64,
  ftp_watts               FLOAT64,                  -- functional threshold power (cycling)
  measurement_preference  STRING,                   -- 'feet' | 'meters'
  created_at              TIMESTAMP,
  updated_at              TIMESTAMP,
  source                  STRING   NOT NULL,
  raw_json                JSON,
  ingested_at             TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id) NOT ENFORCED
)
CLUSTER BY subject_id
OPTIONS (description = "Strava athlete profile snapshot. Cornerstone Phase 1.");
