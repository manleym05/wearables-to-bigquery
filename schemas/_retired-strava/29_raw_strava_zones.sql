-- raw_strava_zones — Strava v3 /athlete/zones (user's HR + power zone definitions).
-- Used downstream for time-in-zone calculations (e.g., z2_minutes derivation).
-- Singleton per subject.

CREATE TABLE IF NOT EXISTS life_ops.raw_strava_zones (
  subject_id          INT64    NOT NULL,
  hr_zones_json       JSON,                          -- array of {min, max} per zone (Z1-Z5)
  power_zones_json    JSON,                          -- array of {min, max} per zone (cycling)
  hr_zones_custom     BOOL,                          -- false = Strava's default 5-zone model
  power_zones_custom  BOOL,
  source              STRING   NOT NULL,
  raw_json            JSON,
  ingested_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id) NOT ENFORCED
)
CLUSTER BY subject_id
OPTIONS (description = "Strava user zone definitions (HR + power). Cornerstone Phase 1.");
