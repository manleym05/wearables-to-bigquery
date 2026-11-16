-- fct_workout_strain (#1) — per-workout-session strain + Z2 discipline, fusing Oura workout
-- windows x intraday HR (`raw_oura_heartrate`).
--
-- Grain: one row per Oura workout session (subject_id, workout_id).
-- strain_score = duration_min x HR-reserve fraction (Karvonen TRIMP-lite): intensity x time.
-- Sessions with no HR samples come back with NULL metrics (LEFT JOIN keeps the row).
--
-- >>> SET THESE TO YOUR OWN PHYSIOLOGY BEFORE USING THIS VIEW. <<<
-- The numbers below are placeholders, not advice, and every output here is derived from them.
--   HR_MAX      190  — your measured maximum heart rate
--   RESTING_HR   60  — your overnight resting nadir
--   Z2_LOW/HIGH 110/130 — your zone 2 band in absolute bpm
-- They are inlined because BigQuery views cannot take parameters. If you need them to vary
-- per person, add columns to `life_ops.profile_static` and join instead of hardcoding.

CREATE OR REPLACE VIEW life_ops.fct_workout_strain AS
WITH samples AS (
  SELECT
    w.subject_id, w.workout_id, w.day, w.activity, w.intensity,
    w.start_datetime AS start_at, w.end_datetime AS end_at,
    ROUND(TIMESTAMP_DIFF(w.end_datetime, w.start_datetime, SECOND) / 60.0, 1) AS duration_min,
    w.calories AS oura_calories,
    h.bpm
  FROM life_ops.raw_oura_workout w
  LEFT JOIN life_ops.raw_oura_heartrate h
    ON h.subject_id = w.subject_id
   AND h.ts BETWEEN w.start_datetime AND w.end_datetime
)
SELECT
  subject_id, day, workout_id, activity, intensity,
  start_at, end_at, duration_min, oura_calories,
  COUNT(bpm) AS n_hr_samples,
  ROUND(AVG(bpm), 1) AS avg_bpm, MAX(bpm) AS max_bpm, MIN(bpm) AS min_bpm,
  -- HR-reserve (Karvonen) and TRIMP-lite strain = duration × HRR
  ROUND(SAFE_DIVIDE(AVG(bpm) - 60, 190 - 60), 3) AS hrr_avg,
  ROUND(duration_min * SAFE_DIVIDE(AVG(bpm) - 60, 190 - 60), 1) AS strain_score,
  -- zone distribution vs the Z2 band set above
  ROUND(100 * COUNTIF(bpm < 110) / NULLIF(COUNT(bpm), 0), 1) AS pct_below_z2,
  ROUND(100 * COUNTIF(bpm BETWEEN 110 AND 130) / NULLIF(COUNT(bpm), 0), 1) AS pct_in_z2,
  ROUND(100 * COUNTIF(bpm > 130) / NULLIF(COUNT(bpm), 0), 1) AS pct_above_z2,
  ROUND(duration_min * SAFE_DIVIDE(COUNTIF(bpm BETWEEN 110 AND 130), NULLIF(COUNT(bpm), 0)), 1) AS min_in_z2,
  -- aerobic base session? (Z2-creep only applies to these)
  activity IN ('running','walking','hiking','cycling','biking','rowing','swimming','elliptical') AS is_cardio,
  -- Z2-creep flag: aerobic session spending >=1/3 of samples above the Z2 ceiling (perceived-easy ≠ actual).
  -- Threshold (0.33) is a Cornerstone default; Life HQ owns the final grounding rule.
  (activity IN ('running','walking','hiking','cycling','biking','rowing','swimming','elliptical')
     AND SAFE_DIVIDE(COUNTIF(bpm > 130), NULLIF(COUNT(bpm), 0)) >= 0.33) AS z2_creep_flag,
  'oura_workout' AS source
FROM samples
GROUP BY subject_id, day, workout_id, activity, intensity, start_at, end_at, duration_min, oura_calories;
