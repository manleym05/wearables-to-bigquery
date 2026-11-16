-- fct_recovery_trend — the TREND guardrail a point-in-time readiness score is blind to.
--
-- WHY THIS EXISTS
-- A daily readiness composite can sit in its normal range for a week while HRV drifts well below
-- its own baseline, because the composite leans on sleep duration while efficiency, deep, REM and
-- WASO quietly degrade. Reading a series catches that; reading one number does not. This view makes
-- it catchable without a human squinting at a chart.
--
-- NON-OVERLAPPING BASELINE is the load-bearing detail. `hrv_base28_ms` covers [D-34, D-7] — it stops
-- 7 days before today, so the trailing-7 window it is compared against never contributes to it. A
-- trailing-28 that includes the last 7 days gets dragged down by the very decline it is meant to
-- detect, which delays the flag exactly when you want it early.
--
-- GAP-SAFE WINDOWS: ranges are over `UNIX_DATE(day)` with RANGE (not ROWS), so a missing day
-- shortens the window rather than silently reaching further back. `n_days_*` expose actual coverage.
--
-- THRESHOLDS ARE YOURS TO FIT. The ones below are a starting point, not a recommendation:
--   RED_WATCH if hrv_trend_pct < -0.20
--             OR (hrv_trend_pct < -0.10 AND hrv_pctile_90d <= 10)
--             OR (hrv_pctile_90d <= 10 AND rhr_trend_pct > +0.05)
-- Fit them against your own history before trusting them, and check the fire rate: a threshold
-- loose enough to catch every episode you remember will also fire on a large share of ordinary
-- days, which makes it noise. RHR in particular is a low-variance signal — a +5% move is a far
-- bigger shift than it sounds, so an RHR-only gate may be unreachable in practice.
--
-- The flag is a conservative default. Whatever consumes it owns the final rule; a trend flag that
-- can override a good readiness score is the entire point.

CREATE OR REPLACE VIEW life_ops.fct_recovery_trend AS
WITH base AS (
  -- One row per day with a finalized HRV print. raw_oura_daily is already main-sleep-sourced
  -- (naps never feed hrv_avg_ms — see pickMainSleepByDay in workers/oura).
  SELECT
    subject_id,
    day,
    UNIX_DATE(day) AS dnum,
    hrv_avg_ms     AS hrv_ms,
    rhr_low_bpm    AS rhr_bpm
  FROM life_ops.raw_oura_daily
  WHERE hrv_avg_ms IS NOT NULL
),
windows AS (
  SELECT
    b.*,
    -- trailing 7 days INCLUDING today
    AVG(hrv_ms) OVER w7  AS hrv_last7_ms,
    AVG(rhr_bpm) OVER w7 AS rhr_last7_bpm,
    COUNT(hrv_ms) OVER w7 AS n_days_last7,
    -- 28-day baseline ending 7 days ago — NON-OVERLAPPING with the trailing-7 above
    AVG(hrv_ms) OVER w28  AS hrv_base28_ms,
    AVG(rhr_bpm) OVER w28 AS rhr_base28_bpm,
    COUNT(hrv_ms) OVER w28 AS n_days_base28
  FROM base b
  WINDOW
    w7  AS (PARTITION BY subject_id ORDER BY dnum RANGE BETWEEN 6  PRECEDING AND CURRENT ROW),
    w28 AS (PARTITION BY subject_id ORDER BY dnum RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING)
),
pctiles AS (
  SELECT
    w.*,
    -- Today's print as a percentile of the trailing 90 days (share of that window at or below today).
    -- Correlated subquery rather than a window function: PERCENT_RANK can't be scoped to a moving range.
    (SELECT COUNTIF(x.hrv_ms <= w.hrv_ms) / COUNT(*) * 100
       FROM base x
      WHERE x.subject_id = w.subject_id
        AND x.dnum BETWEEN w.dnum - 89 AND w.dnum) AS hrv_pctile_90d
  FROM windows w
),
calc AS (
  SELECT
    p.*,
    SAFE_DIVIDE(hrv_last7_ms,  hrv_base28_ms)  - 1 AS hrv_trend_pct,
    SAFE_DIVIDE(rhr_last7_bpm, rhr_base28_bpm) - 1 AS rhr_trend_pct,
    -- Coverage guard: don't fire a trend flag off a thin baseline (early history, travel gaps, ring
    -- off-wrist). 14 of 28 baseline days + 4 of 7 recent days is the minimum evidence we'll act on.
    (n_days_base28 >= 14 AND n_days_last7 >= 4) AS has_coverage
  FROM pctiles p
)
SELECT
  subject_id,
  day,
  -- today's raw prints
  hrv_ms,
  rhr_bpm,
  -- HRV trend components
  ROUND(hrv_last7_ms,  1) AS hrv_last7_ms,
  ROUND(hrv_base28_ms, 1) AS hrv_base28_ms,
  ROUND(hrv_trend_pct, 4) AS hrv_trend_pct,
  ROUND(hrv_pctile_90d, 0) AS hrv_pctile_90d,
  -- RHR mirror (same construction; exposed as a corroborator, not a standalone trigger)
  ROUND(rhr_last7_bpm,  1) AS rhr_last7_bpm,
  ROUND(rhr_base28_bpm, 1) AS rhr_base28_bpm,
  ROUND(rhr_trend_pct, 4) AS rhr_trend_pct,
  -- coverage transparency — a consumer that wants to be stricter than has_coverage can be
  n_days_last7,
  n_days_base28,
  -- THE FLAG. Conservative by construction: INSUFFICIENT_DATA never escalates, it abstains.
  CASE
    WHEN NOT has_coverage THEN 'INSUFFICIENT_DATA'
    WHEN hrv_trend_pct < -0.20                                    THEN 'RED_WATCH'
    WHEN hrv_trend_pct < -0.10 AND hrv_pctile_90d <= 10           THEN 'RED_WATCH'
    WHEN hrv_pctile_90d <= 10 AND rhr_trend_pct > 0.05            THEN 'RED_WATCH'
    WHEN hrv_trend_pct < -0.10                                    THEN 'AMBER'
    ELSE 'GREEN'
  END AS gate_trend_flag,
  'oura' AS source
FROM calc;
