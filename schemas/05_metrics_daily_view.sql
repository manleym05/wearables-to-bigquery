-- metrics_daily — unified long-format view across Cornerstone raw tables.
-- Long format: (day, subject_id, metric, value, unit, source). One row per metric per day per source.
-- Consumers (Life HQ, future MCP server) query this view rather than the raw tables directly.
--
-- 2026-05-20: expanded from Oura-only stub to include all Oura raw_* tables + Withings measure/activity.
-- Strava + Hevy will be added as those sources come online via CREATE OR REPLACE.

CREATE OR REPLACE VIEW life_ops.metrics_daily AS

-- ===== Oura: daily rollup (sleep/readiness/activity merged into one row per wake-day) =====
WITH oura_daily AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'oura' AS source
  FROM life_ops.raw_oura_daily AS d,
  UNNEST([
    STRUCT('hrv_avg_ms'             AS metric, d.hrv_avg_ms              AS value, 'ms'      AS unit),
    STRUCT('rhr_low_bpm',                      d.rhr_low_bpm,                      'bpm'),
    STRUCT('rhr_avg_bpm',                      d.rhr_avg_bpm,                      'bpm'),
    STRUCT('sleep_total_h',                    d.sleep_total_h,                    'h'),
    STRUCT('sleep_deep_h',                     d.sleep_deep_h,                     'h'),
    STRUCT('sleep_rem_h',                      d.sleep_rem_h,                      'h'),
    STRUCT('sleep_light_h',                    d.sleep_light_h,                    'h'),
    STRUCT('sleep_efficiency_pct',             d.sleep_efficiency_pct,             'pct'),
    STRUCT('sleep_score',                      CAST(d.sleep_score AS FLOAT64),     'pts'),
    STRUCT('readiness_score',                  CAST(d.readiness_score AS FLOAT64), 'pts'),
    STRUCT('activity_score',                   CAST(d.activity_score AS FLOAT64),  'pts'),
    STRUCT('steps',                            CAST(d.steps AS FLOAT64),           'count'),
    STRUCT('respiratory_rate',                 d.respiratory_rate,                 'br/min'),
    STRUCT('body_temp_dev_c',                  d.body_temp_dev_c,                  'C'),
    STRUCT('temperature_trend_dev_c',          d.temperature_trend_dev_c,          'C'),
    STRUCT('active_calories',                  CAST(d.active_calories AS FLOAT64), 'kcal'),
    STRUCT('total_calories',                   CAST(d.total_calories AS FLOAT64),  'kcal'),
    STRUCT('avg_met_minutes',                  d.avg_met_minutes,                  'met-min'),
    STRUCT('sedentary_min',                    CAST(d.sedentary_min AS FLOAT64),   'min'),
    STRUCT('non_wear_min',                     CAST(d.non_wear_min AS FLOAT64),    'min'),
    STRUCT('high_activity_min',                CAST(d.high_activity_min AS FLOAT64), 'min'),
    STRUCT('medium_activity_min',              CAST(d.medium_activity_min AS FLOAT64), 'min'),
    STRUCT('low_activity_min',                 CAST(d.low_activity_min AS FLOAT64), 'min'),
    STRUCT('equivalent_walking_m',             d.equivalent_walking_m,             'm')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Oura: daily_stress =====
oura_stress AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'oura' AS source
  FROM life_ops.raw_oura_daily_stress AS s,
  UNNEST([
    STRUCT('stress_high_min'   AS metric, CAST(s.stress_high_s   AS FLOAT64) / 60 AS value, 'min' AS unit),
    STRUCT('recovery_high_min',           CAST(s.recovery_high_s AS FLOAT64) / 60,         'min')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Oura: daily_spo2 =====
oura_spo2 AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'oura' AS source
  FROM life_ops.raw_oura_daily_spo2 AS s,
  UNNEST([
    STRUCT('spo2_avg_pct'                AS metric, s.spo2_avg_pct                              AS value, 'pct' AS unit),
    STRUCT('breathing_disturbance_index',           CAST(s.breathing_disturbance_index AS FLOAT64),       'idx')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Oura: daily_resilience (contributors only; level is categorical) =====
oura_resilience AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'oura' AS source
  FROM life_ops.raw_oura_daily_resilience AS r,
  UNNEST([
    STRUCT('resilience_sleep_recovery'   AS metric, r.sleep_recovery     AS value, 'pts' AS unit),
    STRUCT('resilience_daytime_recovery',           r.daytime_recovery,            'pts'),
    STRUCT('resilience_stress',                     r.stress_contributor,          'pts')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Oura: cardiovascular age =====
oura_cardio AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'oura' AS source
  FROM life_ops.raw_oura_daily_cardio_age AS c,
  UNNEST([
    STRUCT('vascular_age_years'  AS metric, CAST(c.vascular_age_years AS FLOAT64) AS value, 'years' AS unit),
    STRUCT('pulse_wave_velocity',           c.pulse_wave_velocity,                          'm/s')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Oura: VO2 max (sparse) =====
oura_vo2 AS (
  SELECT day, subject_id, 'vo2_max' AS metric, v.vo2_max AS value, 'ml/kg/min' AS unit, 'oura' AS source
  FROM life_ops.raw_oura_vo2_max AS v
  WHERE v.vo2_max IS NOT NULL
),

-- ===== Withings: measure — latest non-null reading per metric per day per subject =====
-- 2026-05-25: was a single-row pick (ROW_NUMBER ... ORDER BY measured_at DESC = 1). Withings
-- splits one weigh-in into several measure-groups sharing the SAME measured_at (scale body-comp,
-- heart pulse, an all-null group), so the tie-break landed nondeterministically on a null-weight
-- group and dropped weight/body-fat/lean-mass for ~half of days (verified 5/14,5/15,5/16,5/19).
-- Fix: aggregate each column independently to its latest non-null value for the day. This both
-- stops the drop AND merges metrics that arrive in different groups at the same instant
-- (e.g. weight from the scale group + heart pulse from its own group). See handoff 2026-05-21.
withings_measure_latest AS (
  SELECT
    subject_id,
    day,
    ARRAY_AGG(weight_kg               IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS weight_kg,
    ARRAY_AGG(fat_ratio_pct           IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS fat_ratio_pct,
    ARRAY_AGG(fat_free_mass_kg        IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS fat_free_mass_kg,
    ARRAY_AGG(fat_mass_kg             IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS fat_mass_kg,
    ARRAY_AGG(muscle_mass_kg          IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS muscle_mass_kg,
    ARRAY_AGG(hydration_kg            IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS hydration_kg,
    ARRAY_AGG(bone_mass_kg            IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS bone_mass_kg,
    ARRAY_AGG(bp_systolic_mmhg        IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS bp_systolic_mmhg,
    ARRAY_AGG(bp_diastolic_mmhg       IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS bp_diastolic_mmhg,
    ARRAY_AGG(heart_pulse_bpm         IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS heart_pulse_bpm,
    ARRAY_AGG(spo2_pct                IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS spo2_pct,
    ARRAY_AGG(body_temp_c            IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS body_temp_c,
    ARRAY_AGG(pulse_wave_velocity_m_s IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS pulse_wave_velocity_m_s,
    ARRAY_AGG(vo2_max                 IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS vo2_max,
    ARRAY_AGG(vascular_age_years      IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS vascular_age_years
  FROM life_ops.raw_withings_measure
  GROUP BY subject_id, day
),
withings_measure AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'withings' AS source
  FROM withings_measure_latest AS d,
  UNNEST([
    STRUCT('weight_kg'           AS metric, d.weight_kg                          AS value, 'kg'   AS unit),
    STRUCT('weight_lb',                     d.weight_kg * 2.20462,                        'lb'),
    STRUCT('body_fat_pct',                  d.fat_ratio_pct,                              'pct'),
    STRUCT('fat_mass_kg',                   d.fat_mass_kg,                                'kg'),
    STRUCT('fat_mass_lb',                   d.fat_mass_kg * 2.20462,                      'lb'),
    STRUCT('lean_mass_kg',                  d.fat_free_mass_kg,                           'kg'),
    STRUCT('lean_mass_lb',                  d.fat_free_mass_kg * 2.20462,                 'lb'),
    STRUCT('muscle_mass_kg',                d.muscle_mass_kg,                             'kg'),
    STRUCT('muscle_mass_lb',                d.muscle_mass_kg * 2.20462,                   'lb'),
    STRUCT('hydration_kg',                  d.hydration_kg,                               'kg'),
    STRUCT('bone_mass_kg',                  d.bone_mass_kg,                               'kg'),
    STRUCT('bp_systolic_mmhg',              d.bp_systolic_mmhg,                           'mmHg'),
    STRUCT('bp_diastolic_mmhg',             d.bp_diastolic_mmhg,                          'mmHg'),
    STRUCT('heart_pulse_bpm',               d.heart_pulse_bpm,                            'bpm'),
    STRUCT('spo2_pct',                      d.spo2_pct,                                   'pct'),
    STRUCT('body_temp_c',                   d.body_temp_c,                                'C'),
    STRUCT('pulse_wave_velocity',           d.pulse_wave_velocity_m_s,                    'm/s'),
    STRUCT('vo2_max',                       d.vo2_max,                                    'ml/kg/min'),
    STRUCT('vascular_age_years',            d.vascular_age_years,                         'years')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Withings: daily activity =====
withings_activity AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'withings' AS source
  FROM life_ops.raw_withings_activity AS a,
  UNNEST([
    STRUCT('steps'           AS metric, CAST(a.steps AS FLOAT64)          AS value, 'count' AS unit),
    STRUCT('distance_m',                a.distance_m,                              'm'),
    STRUCT('elevation_m',               a.elevation_m,                             'm'),
    STRUCT('calories',                  a.calories,                                'kcal'),
    STRUCT('total_calories',            a.total_calories,                          'kcal'),
    STRUCT('hr_avg_bpm',                a.hr_avg_bpm,                              'bpm'),
    STRUCT('hr_min_bpm',                a.hr_min_bpm,                              'bpm'),
    STRUCT('hr_max_bpm',                a.hr_max_bpm,                              'bpm'),
    STRUCT('active_s',                  CAST(a.active_s AS FLOAT64),               's'),
    STRUCT('intense_s',                 CAST(a.intense_s AS FLOAT64),              's'),
    STRUCT('moderate_s',                CAST(a.moderate_s AS FLOAT64),             's'),
    STRUCT('soft_s',                    CAST(a.soft_s AS FLOAT64),                 's')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Withings: sleep (currently empty; populated if a Sleep Mat is added) =====
withings_sleep AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'withings' AS source
  FROM life_ops.raw_withings_sleep AS s,
  UNNEST([
    STRUCT('sleep_total_h'        AS metric, s.total_sleep_h                          AS value, 'h'   AS unit),
    STRUCT('sleep_deep_h',                   s.deep_sleep_h,                                    'h'),
    STRUCT('sleep_rem_h',                    s.rem_sleep_h,                                     'h'),
    STRUCT('sleep_light_h',                  s.light_sleep_h,                                   'h'),
    STRUCT('sleep_score',                    CAST(s.sleep_score AS FLOAT64),                    'pts'),
    STRUCT('sleep_efficiency_pct',           s.sleep_efficiency_pct,                            'pct'),
    STRUCT('hrv_avg_ms',                     s.hrv_avg_ms,                                      'ms'),
    STRUCT('hr_avg_bpm',                     s.hr_avg_bpm,                                      'bpm'),
    STRUCT('apnea_hypopnea_index',           s.apnea_hypopnea_index,                            'events/h')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Strava: RETIRED 2026-06-03 — ingestion decommissioned; run/walk tracking consolidated to
-- Oura (raw_oura_workout + raw_oura_heartrate). raw_strava_* tables dropped. =====

-- ===== Hevy: per-day lifting aggregates =====
hevy_workout_daily AS (
  SELECT
    day, subject_id,
    COUNT(*)                                 AS workout_count,
    SUM(duration_min)                        AS duration_min_sum,
    SUM(total_volume_kg)                     AS volume_kg_sum,
    SUM(total_volume_lb)                     AS volume_lb_sum,
    SUM(total_reps)                          AS reps_sum,
    SUM(set_count)                           AS set_count_sum,
    SUM(exercise_count)                      AS exercise_count_sum,
    AVG(avg_rpe)                             AS avg_rpe_mean
  FROM life_ops.raw_hevy_workout
  GROUP BY day, subject_id
),
hevy_workout_metrics AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'hevy' AS source
  FROM hevy_workout_daily AS d,
  UNNEST([
    STRUCT('lift_workout_count'    AS metric, CAST(d.workout_count   AS FLOAT64)  AS value, 'count' AS unit),
    STRUCT('lift_duration_min',               CAST(d.duration_min_sum AS FLOAT64),          'min'),
    STRUCT('lift_volume_kg',                  d.volume_kg_sum,                              'kg'),
    STRUCT('lift_volume_lb',                  d.volume_lb_sum,                              'lb'),
    STRUCT('lift_total_reps',                 CAST(d.reps_sum AS FLOAT64),                  'count'),
    STRUCT('lift_set_count',                  CAST(d.set_count_sum AS FLOAT64),             'count'),
    STRUCT('lift_exercise_count',             CAST(d.exercise_count_sum AS FLOAT64),        'count'),
    STRUCT('lift_avg_rpe',                    d.avg_rpe_mean,                               'rpe')
  ]) AS m
  WHERE m.value IS NOT NULL
),

-- ===== Hevy: per-day top-set RPE average (across exercises) =====
-- For each (day, exercise), take the heaviest non-warmup set's RPE, then average across exercises.
hevy_top_sets AS (
  SELECT
    day, subject_id, exercise_template_id,
    MAX(weight_kg)  AS top_weight_kg,
    ANY_VALUE(rpe)  AS top_rpe   -- proxy; refined query in downstream views
  FROM life_ops.raw_hevy_set
  WHERE set_type != 'warmup' AND weight_kg IS NOT NULL
  GROUP BY day, subject_id, exercise_template_id
),
hevy_top_set_rpe AS (
  SELECT
    day, subject_id, 'top_set_rpe_avg' AS metric, AVG(top_rpe) AS value, 'rpe' AS unit, 'hevy' AS source
  FROM hevy_top_sets
  WHERE top_rpe IS NOT NULL
  GROUP BY day, subject_id
),

-- ===== Calendar: per-day meeting load by calendar =====
-- Counts only confirmed, non-all-day events with duration > 0.
-- All-day events are informational (birthdays, "a second subject in Atlanta", etc.) — excluded from load.
-- work calendar events have no title but full start/end (freeBusyReader) — they're counted.
calendar_meetings AS (
  SELECT day, subject_id, calendar_id, duration_min
  FROM life_ops.raw_calendar_events
  WHERE status = 'confirmed'
    AND is_all_day = FALSE
    AND duration_min IS NOT NULL
    AND duration_min > 0
),
calendar_daily AS (
  SELECT
    day, subject_id,
    -- Total across all calendars
    COUNT(*)                                                                     AS meeting_count_total,
    SUM(duration_min)                                                            AS meeting_min_total,
    -- Per calendar
    COUNTIF(calendar_id = 'you@example.com')                                 AS meeting_count_personal,
    SUM(IF(calendar_id = 'you@example.com', duration_min, 0))                AS meeting_min_personal,
    COUNTIF(calendar_id = 'you-work@example.com')                               AS meeting_count_work,
    SUM(IF(calendar_id = 'you-work@example.com', duration_min, 0))              AS meeting_min_work,
    COUNTIF(calendar_id = 'partner@example.com')                                    AS meeting_count_partner,
    SUM(IF(calendar_id = 'partner@example.com', duration_min, 0))                   AS meeting_min_partner
  FROM calendar_meetings
  GROUP BY day, subject_id
),
calendar_metrics AS (
  SELECT day, subject_id, m.metric, m.value, m.unit, 'calendar' AS source
  FROM calendar_daily AS d,
  UNNEST([
    STRUCT('meeting_count_total'     AS metric, CAST(d.meeting_count_total     AS FLOAT64) AS value, 'count' AS unit),
    STRUCT('meeting_min_total',                 CAST(d.meeting_min_total       AS FLOAT64),         'min'),
    STRUCT('meeting_count_personal',            CAST(d.meeting_count_personal  AS FLOAT64),         'count'),
    STRUCT('meeting_min_personal',              CAST(d.meeting_min_personal    AS FLOAT64),         'min'),
    STRUCT('meeting_count_work',                CAST(d.meeting_count_work      AS FLOAT64),         'count'),
    STRUCT('meeting_min_work',                  CAST(d.meeting_min_work        AS FLOAT64),         'min'),
    STRUCT('meeting_count_partner',             CAST(d.meeting_count_partner   AS FLOAT64),         'count'),
    STRUCT('meeting_min_partner',               CAST(d.meeting_min_partner     AS FLOAT64),         'min')
  ]) AS m
  WHERE m.value IS NOT NULL AND m.value > 0
)

SELECT * FROM oura_daily
UNION ALL SELECT * FROM oura_stress
UNION ALL SELECT * FROM oura_spo2
UNION ALL SELECT * FROM oura_resilience
UNION ALL SELECT * FROM oura_cardio
UNION ALL SELECT * FROM oura_vo2
UNION ALL SELECT * FROM withings_measure
UNION ALL SELECT * FROM withings_activity
UNION ALL SELECT * FROM withings_sleep
UNION ALL SELECT * FROM hevy_workout_metrics
UNION ALL SELECT * FROM hevy_top_set_rpe
UNION ALL SELECT * FROM calendar_metrics;
