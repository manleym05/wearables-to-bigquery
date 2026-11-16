-- fct_fuel_vs_load — energy balance against recovery, at a lag.
--
-- The question: does running an energy deficit while training load rises show up as HRV
-- suppression a few days later? This view is the instrument, not the answer. It lines up daily
-- energy balance, training strain and lifting volume against HRV at several lags so the question
-- can be asked of your own data.
--
-- READ THE SAMPLE SIZE BEFORE READING THE CORRELATIONS. An n-of-1 series accumulates slowly, and
-- at the sample sizes this view reaches in its first months almost nothing will clear statistical
-- significance. At n=55, for instance, the two-tailed p<0.05 critical value is about |r| = 0.27 —
-- so a correlation of 0.15 is not a weak effect, it is no effect. `n_days` is exposed on every
-- row for exactly this reason.
--
-- The honest default conclusion here is "not supported, and underpowered". Treat a result as a
-- hypothesis to re-check once the series is longer, never as a finding to act on.
--
-- Lags are computed over calendar days, so a gap in the food log shortens a window rather than
-- silently pulling in an older day.

CREATE OR REPLACE VIEW life_ops.fct_fuel_vs_load AS
WITH nutrition AS (
  SELECT
    subject_id, day,
    kcal, protein_g, carbs_g, fat_g, fiber_g,
    expenditure, energy_balance_kcal, energy_balance_7d_kcal,
    timing_confidence, is_today,
    (expenditure IS NOT NULL) AS has_energy_balance
  FROM life_ops.fct_nutrition_daily
),
lift AS (
  SELECT
    subject_id, day,
    ROUND(SUM(total_volume_lb), 0) AS hevy_volume_lb,
    SUM(set_count)                 AS hevy_sets,
    COUNT(*)                       AS n_lift_sessions,
    MIN(start_at)                  AS first_lift_start_at,
    MAX(end_at)                    AS last_lift_end_at
  FROM life_ops.raw_hevy_workout
  GROUP BY subject_id, day
),
strain AS (
  SELECT
    subject_id, day,
    ROUND(SUM(strain_score), 1) AS training_strain,
    ROUND(SUM(min_in_z2), 1)    AS min_in_z2,
    LOGICAL_OR(z2_creep_flag)   AS any_z2_creep
  FROM life_ops.fct_workout_strain
  GROUP BY subject_id, day
),
post_lift_protein AS (
  -- Protein eaten within 2h of the day's LAST lift ending. Entry-grain — this is a window question.
  -- Restricted to time-trustworthy days: on a batch-logged day every entry carries the same fake
  -- timestamp, which would either fabricate or erase the post-lift window entirely.
  SELECT
    l.subject_id, l.day,
    ROUND(SUM(f.protein_g), 1) AS protein_g_within_2h_post_lift,
    ROUND(SUM(f.kcal), 0)      AS kcal_within_2h_post_lift
  FROM lift l
  JOIN life_ops.fct_nutrition_daily nd
    ON nd.subject_id = l.subject_id AND nd.day = l.day AND nd.timing_confidence = 'high'
  JOIN life_ops.raw_macrofactor_food f
    ON f.subject_id = l.subject_id
   AND f.day BETWEEN l.day AND DATE_ADD(l.day, INTERVAL 1 DAY)   -- partition prune; window can cross midnight
   AND f.eaten_at BETWEEN l.last_lift_end_at AND TIMESTAMP_ADD(l.last_lift_end_at, INTERVAL 2 HOUR)
  GROUP BY l.subject_id, l.day
),
recovery AS (
  -- The dependent variable, keyed by the morning it was measured.
  SELECT subject_id, day, hrv_avg_ms, rhr_low_bpm, readiness_score, sleep_score
  FROM life_ops.raw_oura_daily
),
base AS (
  SELECT
    n.subject_id,
    n.day,
    n.is_today,
    -- ── FUEL (day D) ──────────────────────────────────────────────────────────────────────────
    n.kcal, n.protein_g, n.carbs_g, n.fat_g, n.fiber_g,
    n.expenditure,
    n.energy_balance_kcal,
    n.energy_balance_7d_kcal,
    n.has_energy_balance,
    n.timing_confidence,
    ROUND(AVG(n.energy_balance_kcal) OVER w3, 0) AS energy_balance_3d_kcal,
    ROUND(AVG(n.protein_g)           OVER w7, 0) AS protein_7d_g,
    -- ── LOAD (day D) ──────────────────────────────────────────────────────────────────────────
    COALESCE(l.hevy_volume_lb, 0)  AS hevy_volume_lb,
    COALESCE(l.hevy_sets, 0)       AS hevy_sets,
    COALESCE(l.n_lift_sessions, 0) AS n_lift_sessions,
    COALESCE(s.training_strain, 0) AS training_strain,
    s.min_in_z2,
    s.any_z2_creep,
    ROUND(AVG(COALESCE(l.hevy_volume_lb, 0))  OVER w7, 0) AS hevy_volume_7d_lb,
    ROUND(AVG(COALESCE(s.training_strain, 0)) OVER w7, 1) AS training_strain_7d,
    p.protein_g_within_2h_post_lift,
    p.kcal_within_2h_post_lift,
    -- protein per unit of work — the recomp thesis in one number
    ROUND(SAFE_DIVIDE(n.protein_g, NULLIF(l.hevy_volume_lb, 0)) * 1000, 2) AS protein_g_per_1k_lb
  FROM nutrition n
  LEFT JOIN lift   l ON l.subject_id = n.subject_id AND l.day = n.day
  LEFT JOIN strain s ON s.subject_id = n.subject_id AND s.day = n.day
  LEFT JOIN post_lift_protein p ON p.subject_id = n.subject_id AND p.day = n.day
  WINDOW
    w3 AS (PARTITION BY n.subject_id ORDER BY UNIX_DATE(n.day) RANGE BETWEEN 2 PRECEDING AND CURRENT ROW),
    w7 AS (PARTITION BY n.subject_id ORDER BY UNIX_DATE(n.day) RANGE BETWEEN 6 PRECEDING AND CURRENT ROW)
)
SELECT
  b.*,
  -- ── RECOVERY, READ FORWARD (D+1 … D+5) ──────────────────────────────────────────────────────
  -- Lag columns rather than a single next-day join: the passback's hypothesis is a 2–5 day lag, and
  -- a deficit's autonomic cost is not expected to land the very next morning.
  r1.hrv_avg_ms  AS hrv_next_am,      r1.rhr_low_bpm AS rhr_next_am,
  r1.readiness_score AS readiness_next_am,
  r2.hrv_avg_ms  AS hrv_lag2,
  r3.hrv_avg_ms  AS hrv_lag3,
  r4.hrv_avg_ms  AS hrv_lag4,
  r5.hrv_avg_ms  AS hrv_lag5,
  -- trend context on the day itself, so a row is interpretable without re-joining
  t.hrv_trend_pct, t.gate_trend_flag,
  'macrofactor+hevy+oura' AS source
FROM base b
LEFT JOIN recovery r1 ON r1.subject_id = b.subject_id AND r1.day = DATE_ADD(b.day, INTERVAL 1 DAY)
LEFT JOIN recovery r2 ON r2.subject_id = b.subject_id AND r2.day = DATE_ADD(b.day, INTERVAL 2 DAY)
LEFT JOIN recovery r3 ON r3.subject_id = b.subject_id AND r3.day = DATE_ADD(b.day, INTERVAL 3 DAY)
LEFT JOIN recovery r4 ON r4.subject_id = b.subject_id AND r4.day = DATE_ADD(b.day, INTERVAL 4 DAY)
LEFT JOIN recovery r5 ON r5.subject_id = b.subject_id AND r5.day = DATE_ADD(b.day, INTERVAL 5 DAY)
LEFT JOIN life_ops.fct_recovery_trend t ON t.subject_id = b.subject_id AND t.day = b.day;
