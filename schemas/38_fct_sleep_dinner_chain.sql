-- fct_sleep_dinner_chain (#2) — the dinner -> overnight-HR -> sleep -> next-morning-HRV chain.
--
-- One row per night, joining the previous evening's food log to that night's sleep and the
-- following morning's HRV, so questions like "does eating late cost me recovery?" stay
-- answerable from your own data rather than from an article.
--
-- This view only assembles the columns. It asserts no relationship between them, and you should
-- not assume one: an n-of-1 observational series with no controls cannot separate a dinner effect
-- from training load, illness, travel or alcohol on the same day. Treat anything you find here as
-- a question worth asking, not a result.
--
-- D-1, not D: the dinner that shaped a night was eaten the PREVIOUS evening, so food columns are
-- offset by one day from the sleep columns.
--
-- BATCH-LOGGED DAYS. Food trackers timestamp an entry when you TYPE it, not when you ate. A day
-- logged in one sitting collapses to a single late timestamp, which would read as a very late
-- dinner and poison any timing comparison. `dinner_timing_excluded` flags nights whose food rows
-- cluster inside an implausibly short window, so a query can report "n=X, Y excluded".
-- Timing-INDEPENDENT totals (prior_day_kcal / _alcohol_g / _caffeine_mg) stay populated on every
-- night: a batch-logged day's totals are still correct, only its clock is not.

CREATE OR REPLACE VIEW life_ops.fct_sleep_dinner_chain AS
WITH main_sleep AS (
  -- the night's primary overnight sleep (one per wake-date; longest long_sleep wins)
  SELECT subject_id, day, bedtime_start, bedtime_end, total_sleep_h, efficiency_pct,
         latency_min, restless_periods, hr_lowest_bpm, hr_avg_bpm, avg_hrv_ms
  FROM life_ops.raw_oura_sleep
  WHERE type = 'long_sleep'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY subject_id, day ORDER BY total_sleep_h DESC) = 1
),
overnight_hr AS (
  -- intraday HR samples inside the in-bed window → the overnight curve + nadir timing
  SELECT
    s.subject_id, s.day,
    MIN(h.bpm) AS overnight_hr_min,
    ROUND(AVG(h.bpm), 1) AS overnight_hr_avg,
    ARRAY_AGG(TIMESTAMP_DIFF(h.ts, s.bedtime_start, MINUTE) ORDER BY h.bpm ASC, h.ts ASC LIMIT 1)[OFFSET(0)] AS min_to_nadir,
    COUNT(*) AS n_hr_samples
  FROM main_sleep s
  JOIN life_ops.raw_oura_heartrate h
    ON h.subject_id = s.subject_id
   AND h.ts BETWEEN s.bedtime_start AND s.bedtime_end
   AND h.day BETWEEN DATE_SUB(s.day, INTERVAL 1 DAY) AND s.day   -- partition prune (bedtime spans 2 ET days)
  GROUP BY s.subject_id, s.day
),
near_bed AS (
  -- Per-entry intake in the 3 hours before lights-out, and caffeine after noon on the prior day.
  -- Entry-grain (not the daily rollup) because both are window questions about the evening.
  -- The `day BETWEEN` clause is partition pruning, not logic — the window straddles two ET dates.
  SELECT
    s.subject_id, s.day,
    SUM(IF(f.eaten_at BETWEEN TIMESTAMP_SUB(s.bedtime_start, INTERVAL 3 HOUR) AND s.bedtime_start,
           f.alcohol_g, 0))   AS alcohol_g_within_3h_of_bed,
    SUM(IF(f.eaten_at BETWEEN TIMESTAMP_SUB(s.bedtime_start, INTERVAL 3 HOUR) AND s.bedtime_start,
           f.kcal, 0))        AS kcal_within_3h_of_bed,
    SUM(IF(f.day = DATE_SUB(s.day, INTERVAL 1 DAY)
             AND EXTRACT(HOUR FROM DATETIME(f.eaten_at, 'America/New_York')) >= 12,
           f.caffeine_mg, 0)) AS caffeine_mg_after_1200
  FROM main_sleep s
  JOIN life_ops.raw_macrofactor_food f
    ON f.subject_id = s.subject_id
   AND f.day BETWEEN DATE_SUB(s.day, INTERVAL 1 DAY) AND s.day
   AND f.eaten_at IS NOT NULL
  GROUP BY s.subject_id, s.day
)
SELECT
  s.subject_id, s.day,
  s.bedtime_start, s.bedtime_end,
  s.total_sleep_h, s.efficiency_pct, s.latency_min, s.restless_periods,
  -- Oura scalar aggregates (pre-existing #2 inputs)
  s.hr_lowest_bpm AS sleep_hr_lowest_bpm, s.hr_avg_bpm AS sleep_hr_avg_bpm, s.avg_hrv_ms,
  -- intraday HR curve
  o.overnight_hr_min, o.overnight_hr_avg, o.min_to_nadir, o.n_hr_samples,

  -- ── DINNER ARM (prior evening, D−1) ─────────────────────────────────────────────────────────
  DATE_SUB(s.day, INTERVAL 1 DAY) AS dinner_day,
  n.timing_confidence AS dinner_timing_confidence,
  -- TIMING-DERIVED — NULL unless the prior day's log is time-trustworthy.
  -- DINNER = largest evening event (the meal). LAST INTAKE = final event before bed (the "still
  -- digesting at lights-out" question). They are frequently different events and answer different
  -- questions, so both ship — see 46_fct_nutrition_daily.sql for why they were split.
  IF(n.timing_confidence = 'high', n.dinner_at,   NULL) AS dinner_at,
  IF(n.timing_confidence = 'high', n.dinner_kcal, NULL) AS dinner_kcal,
  IF(n.timing_confidence = 'high', n.last_evening_intake_at,   NULL) AS last_intake_at,
  IF(n.timing_confidence = 'high', n.last_evening_intake_kcal, NULL) AS last_intake_kcal,
  -- TOTAL evening load — the Arm 2 primary variable after the 2026-07-26 re-weighting from clock time
  -- to size. Catches split dinners that neither single event represents.
  IF(n.timing_confidence = 'high', n.evening_kcal_total, NULL) AS evening_kcal_total,
  IF(n.timing_confidence = 'high', n.n_evening_events,  NULL) AS n_evening_events,
  IF(n.timing_confidence = 'high',
     ROUND(TIMESTAMP_DIFF(s.bedtime_start, n.dinner_at, MINUTE) / 60.0, 2), NULL) AS hours_dinner_to_bed,
  IF(n.timing_confidence = 'high',
     ROUND(TIMESTAMP_DIFF(s.bedtime_start, n.last_evening_intake_at, MINUTE) / 60.0, 2), NULL)
     AS hours_last_intake_to_bed,
  IF(n.timing_confidence = 'high', ROUND(nb.alcohol_g_within_3h_of_bed, 1), NULL) AS alcohol_g_within_3h_of_bed,
  IF(n.timing_confidence = 'high', ROUND(nb.kcal_within_3h_of_bed, 0),      NULL) AS kcal_within_3h_of_bed,
  IF(n.timing_confidence = 'high', ROUND(nb.caffeine_mg_after_1200, 0),     NULL) AS caffeine_mg_after_1200,
  -- The exclusion counter. Any dinner-timing correlation MUST report this alongside n.
  (n.day IS NOT NULL AND n.timing_confidence != 'high') AS dinner_timing_excluded,
  -- TIMING-INDEPENDENT — valid even on a batch-logged day; totals are right, only the clock is wrong.
  ROUND(n.kcal, 0)       AS prior_day_kcal,
  ROUND(n.protein_g, 0)  AS prior_day_protein_g,
  ROUND(n.alcohol_g, 1)  AS prior_day_alcohol_g,
  ROUND(n.caffeine_mg, 0) AS prior_day_caffeine_mg,
  n.energy_balance_kcal  AS prior_day_energy_balance_kcal,

  -- morning recovery outcome (the chain's dependent variable)
  d.readiness_score, d.sleep_score, d.body_temp_dev_c,
  'oura+macrofactor' AS source
-- Explicit ON throughout: with four joins in play, USING(subject_id, day) is ambiguous.
FROM main_sleep s
LEFT JOIN overnight_hr o
  ON o.subject_id = s.subject_id AND o.day = s.day
LEFT JOIN near_bed nb
  ON nb.subject_id = s.subject_id AND nb.day = s.day
-- ⚠️ D−1, not D: the dinner that shaped this night was eaten the PREVIOUS evening.
LEFT JOIN life_ops.fct_nutrition_daily n
  ON n.subject_id = s.subject_id AND n.day = DATE_SUB(s.day, INTERVAL 1 DAY)
LEFT JOIN life_ops.raw_oura_daily d
  ON d.subject_id = s.subject_id AND d.day = s.day;
