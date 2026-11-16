-- Phase-2 review surface — weekly rollup + longevity/recovery scorecard.
-- Built 2026-06-07 (Life HQ task #17). Two views layered on life_ops.metrics_daily (05):
--
--   life_ops.metrics_weekly      general primitive — one row per (week, subject, metric, source)
--                                with avg/min/max/sum + day-coverage. Long format, like metrics_daily
--                                but bucketed to ISO weeks (Monday start, matching the training cycle
--                                + Sunday review cadence).
--   life_ops.longevity_scorecard review-facing WIDE surface — one row per week with the headline
--                                recovery / longevity / body-comp / training KPIs as columns, plus
--                                week-over-week deltas and 4-week trailing baselines for the markers
--                                the weekly/monthly review leads with. This is what reviews query.
--
-- Why weekly: single-day biometrics are noisy (HRV CV ~26%); the review reasons in weekly trend +
-- trailing baseline, exactly what the daily gate's 7-day baseline does but at review cadence.
--
-- Notes / v2 enhancements (deliberately NOT in v1):
--   - vs-target columns: `life_ops.targets` currently carries only nutrition + weight + Z2 targets,
--     and its metric names don't line up with metrics_daily (weight_trend_lb vs weight_lb). Once
--     whatever biomarker targets you track land in `targets`, LEFT JOIN them here for a
--     "vs target" column.
--   - Z2 weekly minutes: not cleanly in metrics_daily yet (Oura workouts live in raw_oura_workout,
--     not rolled into the long view). Add a z2_min rollup when that lands.
--   - vo2_max + vascular_age are SPARSE (Oura computes them infrequently) — weekly cells are often
--     NULL. That's expected; the review carries forward the last known value.
--   - raw_calendar_events extends ~1 year into the future (scheduled meetings), so the scorecard caps
--     at the current week (WHERE week_start <= this Monday) to avoid empty future rows. A rare
--     multi-day timed work event can inflate meeting_min_work_week (known calendar-data quirk).

-- ===== life_ops.metrics_weekly — general weekly rollup of the long metrics view =====
CREATE OR REPLACE VIEW life_ops.metrics_weekly AS
SELECT
  DATE_TRUNC(day, WEEK(MONDAY)) AS week_start,
  subject_id,
  metric,
  source,
  ANY_VALUE(unit)     AS unit,
  AVG(value)          AS avg_value,
  MIN(value)          AS min_value,
  MAX(value)          AS max_value,
  SUM(value)          AS sum_value,   -- weekly total (use for count/duration metrics: sets, minutes)
  COUNT(DISTINCT day) AS n_days       -- day coverage in the week (0-7) — watch for thin weeks
FROM life_ops.metrics_daily
GROUP BY week_start, subject_id, metric, source;

-- ===== life_ops.longevity_scorecard — review-facing wide weekly KPI surface =====
CREATE OR REPLACE VIEW life_ops.longevity_scorecard AS
WITH wk AS (
  SELECT
    week_start,
    subject_id,
    -- Recovery / autonomic (Oura) — weekly means
    MAX(IF(metric = 'hrv_avg_ms'                AND source = 'oura', avg_value, NULL)) AS hrv_avg_ms,
    MAX(IF(metric = 'rhr_low_bpm'               AND source = 'oura', avg_value, NULL)) AS rhr_low_bpm,
    MAX(IF(metric = 'readiness_score'           AND source = 'oura', avg_value, NULL)) AS readiness_score,
    MAX(IF(metric = 'sleep_score'               AND source = 'oura', avg_value, NULL)) AS sleep_score,
    MAX(IF(metric = 'sleep_total_h'             AND source = 'oura', avg_value, NULL)) AS sleep_total_h,
    MAX(IF(metric = 'resilience_sleep_recovery' AND source = 'oura', avg_value, NULL)) AS resilience_sleep_recovery,
    MAX(IF(metric = 'stress_high_min'           AND source = 'oura', avg_value, NULL)) AS stress_high_min_avg,
    -- Longevity / cardio-respiratory (Oura) — sparse markers take the week's value
    MAX(IF(metric = 'vo2_max'                     AND source = 'oura', max_value, NULL)) AS vo2_max,
    MAX(IF(metric = 'vascular_age_years'          AND source = 'oura', avg_value, NULL)) AS vascular_age_years,
    MAX(IF(metric = 'spo2_avg_pct'                AND source = 'oura', avg_value, NULL)) AS spo2_avg_pct,
    MAX(IF(metric = 'breathing_disturbance_index' AND source = 'oura', avg_value, NULL)) AS breathing_disturbance_index,
    -- Body composition (Withings) — weekly mean of fasted weigh-ins
    MAX(IF(metric = 'weight_lb'    AND source = 'withings', avg_value, NULL)) AS weight_lb,
    MAX(IF(metric = 'body_fat_pct' AND source = 'withings', avg_value, NULL)) AS body_fat_pct,
    MAX(IF(metric = 'lean_mass_lb' AND source = 'withings', avg_value, NULL)) AS lean_mass_lb,
    -- Training load (Hevy) — weekly totals + intensity
    MAX(IF(metric = 'lift_workout_count' AND source = 'hevy', sum_value, NULL)) AS lift_sessions_week,
    MAX(IF(metric = 'lift_set_count'     AND source = 'hevy', sum_value, NULL)) AS lift_sets_week,
    MAX(IF(metric = 'lift_volume_lb'     AND source = 'hevy', sum_value, NULL)) AS lift_volume_lb_week,
    MAX(IF(metric = 'lift_avg_rpe'       AND source = 'hevy', avg_value, NULL)) AS lift_avg_rpe,
    -- Demand context (Calendar) — weekly work-meeting minutes
    MAX(IF(metric = 'meeting_min_work'   AND source = 'calendar', sum_value, NULL)) AS meeting_min_work_week,
    -- Coverage (how many days of Oura fed this week — trust gate on thin weeks)
    MAX(IF(metric = 'hrv_avg_ms'         AND source = 'oura', n_days, NULL)) AS oura_days
  FROM life_ops.metrics_weekly
  GROUP BY week_start, subject_id
)
SELECT
  wk.*,
  -- Week-over-week deltas on the markers the review leads with
  ROUND(hrv_avg_ms         - LAG(hrv_avg_ms)         OVER w, 1) AS hrv_wow,
  ROUND(rhr_low_bpm        - LAG(rhr_low_bpm)        OVER w, 1) AS rhr_wow,
  ROUND(sleep_score        - LAG(sleep_score)        OVER w, 1) AS sleep_score_wow,
  ROUND(sleep_total_h      - LAG(sleep_total_h)      OVER w, 2) AS sleep_h_wow,
  ROUND(weight_lb          - LAG(weight_lb)          OVER w, 2) AS weight_lb_wow,
  ROUND(body_fat_pct       - LAG(body_fat_pct)       OVER w, 2) AS body_fat_pct_wow,
  ROUND(lean_mass_lb       - LAG(lean_mass_lb)       OVER w, 2) AS lean_mass_lb_wow,
  ROUND(vascular_age_years - LAG(vascular_age_years) OVER w, 1) AS vascular_age_wow,
  -- 4-week trailing baselines (exclude the current week) — the review's "vs recent normal"
  ROUND(AVG(hrv_avg_ms)  OVER (PARTITION BY subject_id ORDER BY week_start ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING), 1) AS hrv_4wk_base,
  ROUND(AVG(rhr_low_bpm) OVER (PARTITION BY subject_id ORDER BY week_start ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING), 1) AS rhr_4wk_base,
  ROUND(AVG(weight_lb)   OVER (PARTITION BY subject_id ORDER BY week_start ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING), 1) AS weight_4wk_base
FROM wk
WHERE week_start <= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))   -- cap at the current week (calendar runs ~1yr ahead)
WINDOW w AS (PARTITION BY subject_id ORDER BY week_start)
ORDER BY week_start DESC;

-- ===== Activation 2026-06-07 PM (task #17): targets + vs-target + monthly rollup =====
-- Seeded the headline recovery/recomp targets into life_ops.targets (canonical seed: 07_seed_targets.sql):
--   hrv_avg_ms=47 (Phase A 44.3→≥47), lean_mass_lb=150 (recomp ref), sleep_total_h=7.5, weight_lb=172.
-- These use SCORECARD metric names so they LEFT JOIN cleanly (the legacy weight_trend_lb/z2_minutes stay).
-- Not in `targets` yet: any lab-panel biomarker (no lab feed in metrics_daily), VO2max, vascular-age.

-- review_targets_current — latest target per metric, for the review's vs-target join.
CREATE OR REPLACE VIEW life_ops.review_targets_current AS
SELECT subject_id, metric, target_value, unit, note
FROM (
  SELECT subject_id, metric, value AS target_value, unit, note,
         ROW_NUMBER() OVER (PARTITION BY subject_id, metric ORDER BY effective_date DESC) AS rn
  FROM life_ops.targets
)
WHERE rn = 1;

-- longevity_monthly — monthly rollup for the SLOW-MOVING markers (VO2max, vascular age) that are too
-- sparse/noisy weekly. Plain monthly means; the monthly retro reads this for the longevity scorecard.
CREATE OR REPLACE VIEW life_ops.longevity_monthly AS
SELECT
  DATE_TRUNC(day, MONTH) AS month_start, subject_id,
  COUNT(DISTINCT IF(metric='hrv_avg_ms' AND source='oura', day, NULL)) AS oura_days,
  ROUND(AVG(IF(metric='hrv_avg_ms'          AND source='oura', value, NULL)),1) AS hrv_avg_ms,
  ROUND(AVG(IF(metric='rhr_low_bpm'         AND source='oura', value, NULL)),1) AS rhr_low_bpm,
  ROUND(AVG(IF(metric='sleep_score'         AND source='oura', value, NULL)),1) AS sleep_score,
  ROUND(AVG(IF(metric='sleep_total_h'       AND source='oura', value, NULL)),2) AS sleep_total_h,
  ROUND(AVG(IF(metric='vo2_max'             AND source='oura', value, NULL)),1) AS vo2_max,
  ROUND(AVG(IF(metric='vascular_age_years'  AND source='oura', value, NULL)),1) AS vascular_age_years,
  ROUND(AVG(IF(metric='spo2_avg_pct'        AND source='oura', value, NULL)),1) AS spo2_avg_pct,
  ROUND(AVG(IF(metric='weight_lb'           AND source='withings', value, NULL)),1) AS weight_lb,
  ROUND(AVG(IF(metric='body_fat_pct'        AND source='withings', value, NULL)),1) AS body_fat_pct,
  ROUND(AVG(IF(metric='lean_mass_lb'        AND source='withings', value, NULL)),1) AS lean_mass_lb,
  ROUND(SUM(IF(metric='lift_set_count'      AND source='hevy', value, NULL)))     AS lift_sets_month
FROM life_ops.metrics_daily
WHERE day <= CURRENT_DATE()
GROUP BY month_start, subject_id
ORDER BY month_start DESC;
