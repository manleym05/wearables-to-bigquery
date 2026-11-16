-- fct_nutrition_daily — targets vs actuals, energy balance, and MEAL-TIMING CONFIDENCE.
-- Built 2026-07-26 from the Life HQ passback (P2). One row per day.
--
-- ⚠️⚠️ THE BATCH-LOGGING PROBLEM — the reason this view is not just a SELECT off raw_macrofactor_daily.
--
-- A real example from a food log: an ENTIRE day's intake stamped at one late-evening minute,
-- because he logged the whole day at night. The MF export contains **no entry-time, only an
-- eaten-time**, so batch entry is UNDETECTABLE from the data itself. A naive dinner-timing analytic
-- would score that day as a single 19:43 meal and feed a false signal straight into the sleep
-- experiment's Arm 2 — "late dinner wrecked recovery" when in truth he ate normally and typed it up
-- after dinner.
--
-- This is the difference between a useful dinner-timing model and a misleading one, so timing
-- confidence is computed here and **every timestamp-derived metric downstream MUST filter to
-- `timing_confidence = 'high'` and report the exclusion count.** A dinner-timing correlation over 90
-- days should read "n=83, 7 excluded as batch-logged". Silent inclusion is how a plausible-but-wrong
-- finding gets into a review.
--
-- Heuristic (passback's, implemented verbatim):
--   batch_log_suspected = (n_eating_events <= 2 AND pct_kcal_largest_event >= 0.75
--                          AND kcal_in_largest_event >= 1500)
--                      OR (intake_span_h < 2 AND kcal > 2000)
-- An "eating event" is a cluster of entries; a gap > 45 min starts a new one.
--
-- The honest long-term fix is a lightweight in-app confirm. The flag costs nothing and is enough.
--
-- DESIGN CAUTION (learned in W30): this view exposes the DAILY SERIES, not just weekly rollups. The
-- A weekly mean can hide a within-week trend entirely. Adding data without adding granularity
-- just builds a faster path to the same mistake.
--
-- ⚠️ THE TWO SHEETS ARRIVE SEPARATELY. MacroFactor exports the Food Log and the Quick Export (daily)
-- as independent files — the 2026-07-26 export was a food-log CSV with no daily sheet at all. So this
-- view is anchored on a UNION day-spine, not on raw_macrofactor_daily: an export of either half alone
-- still produces rows. (Anchoring on the daily table meant 1,737 real food rows rendered as zero.)
--   • `intake_source` = 'daily_sheet' when MF's own rollup is present, else 'food_log' (summed from
--     entries), else NULL. Prefer the daily sheet when both exist — it is MF's own reconciliation.
--   • `expenditure`, the macro TARGETS and `trend_weight_lb` exist ONLY in the daily sheet. Without it
--     `energy_balance_kcal` is NULL — it is not zero, and must not be read as balanced.

CREATE OR REPLACE VIEW life_ops.fct_nutrition_daily AS
WITH events AS (
  -- Cluster food entries into eating events: a gap of more than 45 min opens a new event.
  SELECT
    subject_id, day, eaten_at, kcal,
    SUM(is_new_event) OVER (PARTITION BY subject_id, day ORDER BY eaten_at
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS event_idx
  FROM (
    SELECT
      subject_id, day, eaten_at, kcal,
      IF(prev_at IS NULL
         OR TIMESTAMP_DIFF(eaten_at, prev_at, MINUTE) > 45, 1, 0) AS is_new_event
    FROM (
      SELECT subject_id, day, eaten_at, kcal,
             LAG(eaten_at) OVER (PARTITION BY subject_id, day ORDER BY eaten_at) AS prev_at
      FROM life_ops.raw_macrofactor_food
      WHERE eaten_at IS NOT NULL
    )
  )
),
event_totals AS (
  SELECT subject_id, day, event_idx,
         SUM(kcal)     AS event_kcal,
         MIN(eaten_at) AS event_start,
         MAX(eaten_at) AS event_end
  FROM events
  GROUP BY subject_id, day, event_idx
),
timing AS (
  SELECT
    subject_id, day,
    COUNT(*)                AS n_eating_events,
    MAX(event_kcal)         AS kcal_in_largest_event,
    SUM(event_kcal)         AS kcal_from_log,
    MIN(event_start)        AS first_intake_at,
    MAX(event_end)          AS last_intake_at,
    ROUND(TIMESTAMP_DIFF(MAX(event_end), MIN(event_start), MINUTE) / 60.0, 2) AS intake_span_h,

    -- ── EVENING INTAKE: two DIFFERENT questions, so two different fields. ──────────────────────
    -- Earlier these were mixed: `dinner_at` took the LAST evening event's start while `dinner_kcal`
    -- took the LARGEST evening event's calories — often not the same event. That paired a 21:00
    -- snack's timestamp with the 18:00 meal's size (a logged day can read "dinner = 179 kcal" because a
    -- late snack supplied the time). Both are now event-consistent via ordered ARRAY_AGG.
    --
    -- DINNER = the LARGEST eating event starting >= 16:00 — the actual meal.
    ARRAY_AGG(IF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16, event_start, NULL)
              IGNORE NULLS ORDER BY event_kcal DESC, event_start LIMIT 1)[SAFE_OFFSET(0)] AS dinner_at,
    ARRAY_AGG(IF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16, event_kcal, NULL)
              IGNORE NULLS ORDER BY event_kcal DESC, event_start LIMIT 1)[SAFE_OFFSET(0)] AS dinner_kcal,
    -- LAST EVENING INTAKE = the final event of the day, whatever its size. This is the one that
    -- governs "still digesting at lights-out"; a 200 kcal 22:00 snack matters for that question and
    -- is irrelevant to "how big was dinner".
    ARRAY_AGG(IF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16, event_start, NULL)
              IGNORE NULLS ORDER BY event_start DESC LIMIT 1)[SAFE_OFFSET(0)] AS last_evening_intake_at,
    ARRAY_AGG(IF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16, event_kcal, NULL)
              IGNORE NULLS ORDER BY event_start DESC LIMIT 1)[SAFE_OFFSET(0)] AS last_evening_intake_kcal,
    -- TOTAL evening load (all events from 16:00), distinct from `kcal_in_largest_event` which is the
    -- largest event of the WHOLE day and may be lunch. Requested by Life HQ 2026-07-26 when Arm 2 was
    -- re-weighted from dinner clock-time to evening-meal SIZE — this is the variable that re-weighting
    -- should track, and it captures the split-dinner case (e.g. 1,058 kcal at 16:08 plus 840 at
    -- 20:59; neither event alone represents the evening).
    SUM(IF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16, event_kcal, 0)) AS evening_kcal_total,
    COUNTIF(EXTRACT(HOUR FROM DATETIME(event_start, 'America/New_York')) >= 16)                AS n_evening_events
  FROM event_totals
  GROUP BY subject_id, day
),
flagged AS (
  SELECT
    t.*,
    SAFE_DIVIDE(kcal_in_largest_event, NULLIF(kcal_from_log, 0)) AS pct_kcal_largest_event
  FROM timing t
),
food_totals AS (
  -- Intake summed straight from the entries — the fallback when MF's daily sheet hasn't been exported.
  SELECT
    subject_id, day,
    SUM(kcal)           AS kcal,
    SUM(protein_g)      AS protein_g,
    SUM(fat_g)          AS fat_g,
    SUM(carbs_g)        AS carbs_g,
    SUM(fiber_g)        AS fiber_g,
    SUM(sat_fat_g)      AS sat_fat_g,
    SUM(sugars_added_g) AS sugars_added_g,
    SUM(alcohol_g)      AS alcohol_g,
    SUM(caffeine_mg)    AS caffeine_mg,
    COUNT(*)            AS n_food_entries
  FROM life_ops.raw_macrofactor_food
  GROUP BY subject_id, day
),
spine AS (
  -- Every day either sheet knows about. Neither table is the anchor.
  SELECT subject_id, day FROM life_ops.raw_macrofactor_daily
  UNION DISTINCT
  SELECT subject_id, day FROM life_ops.raw_macrofactor_food
),
merged AS (
  SELECT
    s.subject_id,
    s.day,
    -- daily-sheet-only fields
    d.expenditure, d.trend_weight_lb, d.scale_weight_lb,
    d.target_kcal, d.target_protein_g, d.target_fat_g, d.target_carbs_g,
    d.export_file,
    -- intake: MF's own rollup wins; fall back to summing the log
    COALESCE(d.kcal,           ft.kcal)           AS kcal,
    COALESCE(d.protein_g,      ft.protein_g)      AS protein_g,
    COALESCE(d.fat_g,          ft.fat_g)          AS fat_g,
    COALESCE(d.carbs_g,        ft.carbs_g)        AS carbs_g,
    COALESCE(d.fiber_g,        ft.fiber_g)        AS fiber_g,
    COALESCE(d.sat_fat_g,      ft.sat_fat_g)      AS sat_fat_g,
    COALESCE(d.sugars_added_g, ft.sugars_added_g) AS sugars_added_g,
    COALESCE(d.alcohol_g,      ft.alcohol_g)      AS alcohol_g,
    COALESCE(d.caffeine_mg,    ft.caffeine_mg)    AS caffeine_mg,
    ft.n_food_entries,
    CASE WHEN d.kcal IS NOT NULL THEN 'daily_sheet'
         WHEN ft.kcal IS NOT NULL THEN 'food_log'
         ELSE NULL END AS intake_source
  FROM spine s
  LEFT JOIN life_ops.raw_macrofactor_daily d ON d.subject_id = s.subject_id AND d.day = s.day
  LEFT JOIN food_totals ft                   ON ft.subject_id = s.subject_id AND ft.day = s.day
)
SELECT
  d.subject_id,
  d.day,

  -- ── INTAKE vs TARGET ───────────────────────────────────────────────────────────────────────
  d.kcal, d.protein_g, d.fat_g, d.carbs_g,
  d.target_kcal, d.target_protein_g, d.target_fat_g, d.target_carbs_g,
  d.fiber_g, d.sat_fat_g, d.sugars_added_g, d.alcohol_g, d.caffeine_mg,
  -- Explicit booleans, not thresholds re-derived by every consumer. Floors from the Q2 KPI set.
  (d.protein_g  >= 150) AS protein_ok,
  (d.fiber_g    >= 35)  AS fiber_ok,
  (d.sat_fat_g  <= 25)  AS sat_ok,

  -- ── ENERGY BALANCE — the field a deficit-vs-load question needs ─────────────────
  d.expenditure,
  ROUND(d.kcal - d.expenditure, 0) AS energy_balance_kcal,
  ROUND(AVG(d.kcal - d.expenditure) OVER w7, 0) AS energy_balance_7d_kcal,
  ROUND(AVG(d.kcal)      OVER w7, 0) AS kcal_7d,
  ROUND(AVG(d.protein_g) OVER w7, 0) AS protein_7d,
  ROUND(AVG(d.fiber_g)   OVER w7, 0) AS fiber_7d,
  ROUND(AVG(d.sat_fat_g) OVER w7, 0) AS sat_fat_7d,

  -- ── BODY COMP (MF's own view; Withings remains primary for scale weight) ───────────────────
  d.trend_weight_lb, d.scale_weight_lb,

  -- ── MEAL TIMING + CONFIDENCE ──────────────────────────────────────────────────────────────
  f.n_eating_events,
  ROUND(f.kcal_in_largest_event, 0)  AS kcal_in_largest_event,
  ROUND(f.pct_kcal_largest_event, 3) AS pct_kcal_largest_event,
  f.first_intake_at,
  f.last_intake_at,
  f.intake_span_h,
  f.dinner_at,
  ROUND(f.dinner_kcal, 0) AS dinner_kcal,
  f.last_evening_intake_at,
  ROUND(f.last_evening_intake_kcal, 0) AS last_evening_intake_kcal,
  ROUND(f.evening_kcal_total, 0)       AS evening_kcal_total,
  f.n_evening_events,

  COALESCE(
    (f.n_eating_events <= 2 AND f.pct_kcal_largest_event >= 0.75 AND f.kcal_in_largest_event >= 1500)
    OR (f.intake_span_h < 2 AND d.kcal > 2000),
    FALSE
  ) AS batch_log_suspected,

  CASE
    WHEN f.subject_id IS NULL OR f.n_eating_events IS NULL THEN 'unknown'   -- daily row, no food log
    WHEN (f.n_eating_events <= 2 AND f.pct_kcal_largest_event >= 0.75 AND f.kcal_in_largest_event >= 1500)
      OR (f.intake_span_h < 2 AND d.kcal > 2000)                            THEN 'low'
    ELSE 'high'
  END AS timing_confidence,

  -- ⚠️ TODAY IS ALWAYS INCOMPLETE. An export taken mid-day logs only what has been eaten so far, so
  -- today's kcal/energy_balance are partial and will distort any mean or rolling window that includes
  -- them. On a partial export the current day reads as a large deficit purely because the
  -- six complete days and −456.1 with the export day included — the same class of silent distortion
  -- day is incomplete. **Filter `NOT is_today` for any aggregate.**
  (d.day >= CURRENT_DATE('America/New_York')) AS is_today,
  -- Provenance: which sheet the intake numbers came from, and how many entries backed them.
  d.intake_source,
  d.n_food_entries,
  d.export_file,
  'macrofactor' AS source
FROM merged d
LEFT JOIN flagged f
  ON f.subject_id = d.subject_id AND f.day = d.day
WINDOW w7 AS (PARTITION BY d.subject_id ORDER BY UNIX_DATE(d.day) RANGE BETWEEN 6 PRECEDING AND CURRENT ROW);
