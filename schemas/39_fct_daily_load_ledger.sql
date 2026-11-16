-- fct_daily_load_ledger (#4) — the spend<->recovery ledger, one row per day. Combines training
-- strain and overnight recovery into a timeline that makes a morning's recovery explainable
-- ("today's HRV dip follows yesterday's hard session") and partly predictive.
--
-- Temporal model (the key idea): each row D pairs THIS MORNING's recovery outcome with the spend
-- that produced it. Yesterday's training (day D-1) spent capacity, so it shows up in D's overnight
-- recovery. Today's training (day D) lands AFTER this morning's measurement, so it is the leading
-- indicator for D+1.
--   - recovery (today):        hrv/rhr/readiness/sleep/overnight-HR for day D
--   - prior_day_* (the cause): yesterday's (D-1) training strain + lifting volume
--   - today_* (the forecast):  today's (D) training strain + volume, predicting tomorrow
--
-- Deliberately no composite score. The columns stay transparent so whatever consumes them owns the
-- thresholds. This is correlational n-of-1 data: a ledger row is evidence for a question, not a
-- verdict, and nothing here should auto-loosen a training decision.
--
-- Point-in-time recovery columns are blind to a slow decline — a readiness score can print fine
-- for a week while HRV drifts well below its own baseline. `hrv_trend_pct` / `hrv_pctile_90d` /
-- `gate_trend_flag` ride on every row from life_ops.fct_recovery_trend to cover that; see
-- 42_fct_recovery_trend.sql for how they are built.
--
-- RETIRED SIGNAL: `recovery_override_count` counts GATE OUTPUT, not recovery, so it cannot register
-- a decline that never fired the gate. It is a gate-behaviour diagnostic only.

CREATE OR REPLACE VIEW life_ops.fct_daily_load_ledger AS
WITH daily_strain AS (
  SELECT subject_id, day,
         COUNT(*)                       AS n_workouts,
         ROUND(SUM(strain_score), 1)    AS training_strain,
         ROUND(SUM(min_in_z2), 1)       AS min_in_z2,
         MAX(pct_above_z2)              AS max_pct_above_z2,
         LOGICAL_OR(z2_creep_flag)      AS any_z2_creep
  FROM life_ops.fct_workout_strain
  GROUP BY subject_id, day
),
hevy_daily AS (
  SELECT subject_id, day,
         ROUND(SUM(total_volume_lb), 0) AS hevy_volume_lb,
         SUM(set_count)                 AS hevy_set_count
  FROM life_ops.raw_hevy_workout
  GROUP BY subject_id, day
)
SELECT
  d.subject_id, d.day,
  -- RECOVERY (this morning — the dependent variable)
  sd.avg_hrv_ms              AS hrv_ms,
  sd.sleep_hr_lowest_bpm     AS rhr_bpm,
  d.readiness_score, d.sleep_score,
  sd.total_sleep_h, sd.efficiency_pct AS sleep_efficiency_pct,
  sd.overnight_hr_avg, sd.min_to_nadir,
  -- RECOVERY TREND (point-in-time recovery above, direction of travel here)
  rt.hrv_last7_ms, rt.hrv_base28_ms, rt.hrv_trend_pct, rt.hrv_pctile_90d,
  rt.rhr_last7_bpm, rt.rhr_base28_bpm, rt.rhr_trend_pct,
  COALESCE(rt.gate_trend_flag, 'INSUFFICIENT_DATA') AS gate_trend_flag,
  -- TODAY's training spend (lands after this AM → leading indicator for tomorrow)
  COALESCE(ts.n_workouts, 0)      AS today_n_workouts,
  COALESCE(ts.training_strain, 0) AS today_training_strain,
  ts.min_in_z2                    AS today_min_in_z2,
  ts.any_z2_creep                 AS today_z2_creep,
  COALESCE(hv.hevy_volume_lb, 0)  AS today_hevy_volume_lb,
  COALESCE(hv.hevy_set_count, 0)  AS today_hevy_sets,
  -- YESTERDAY's spend (explains this morning's recovery)
  COALESCE(ys.training_strain, 0) AS prior_day_training_strain,
  ys.any_z2_creep                 AS prior_day_z2_creep,
  COALESCE(yhv.hevy_volume_lb, 0) AS prior_day_hevy_volume_lb,
  -- WORK-STRESS arm — shelved (synergy #3 falsified for HR; needs intraday HRV)
  CAST(NULL AS FLOAT64)           AS work_stress_score,
  'fusion' AS source
FROM life_ops.raw_oura_daily d
LEFT JOIN life_ops.fct_sleep_dinner_chain sd
  ON sd.subject_id = d.subject_id AND sd.day = d.day
LEFT JOIN life_ops.fct_recovery_trend rt
  ON rt.subject_id = d.subject_id AND rt.day = d.day
LEFT JOIN daily_strain ts
  ON ts.subject_id = d.subject_id AND ts.day = d.day
LEFT JOIN hevy_daily hv
  ON hv.subject_id = d.subject_id AND hv.day = d.day
LEFT JOIN daily_strain ys
  ON ys.subject_id = d.subject_id AND ys.day = DATE_SUB(d.day, INTERVAL 1 DAY)
LEFT JOIN hevy_daily yhv
  ON yhv.subject_id = d.subject_id AND yhv.day = DATE_SUB(d.day, INTERVAL 1 DAY);
