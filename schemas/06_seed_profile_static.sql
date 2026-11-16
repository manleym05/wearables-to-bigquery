-- Seed profile_static with YOUR profile. Edit the values below before running.
-- Idempotent: MERGE on subject_id — re-run safely to refresh values.
--
-- subject_id is the dataset-wide convention for "whose data is this". Use 1 for
-- yourself. If you ever add a second person, give them 2 and nothing else has to change.

MERGE life_ops.profile_static T
USING (
  SELECT
    1                  AS subject_id,
    'Example Person'   AS display_name,
    DATE '1990-01-01'  AS dob,              -- drives age-based metrics (e.g. HR zones)
    'M'                AS sex,
    175.0              AS height_cm,
    'Your City, ST'    AS location,
    'America/New_York' AS timezone          -- drives wake-date normalization
) S
ON T.subject_id = S.subject_id
WHEN MATCHED THEN UPDATE SET
  display_name = S.display_name, dob = S.dob, sex = S.sex,
  height_cm = S.height_cm, location = S.location, timezone = S.timezone,
  updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (subject_id, display_name, dob, sex, height_cm, location, timezone, updated_at)
VALUES
  (S.subject_id, S.display_name, S.dob, S.sex, S.height_cm, S.location, S.timezone, CURRENT_TIMESTAMP());
