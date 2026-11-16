-- raw_oura_sleep — one row per sleep SESSION (Oura v2 /usercollection/sleep).
-- Richer than raw_oura_daily: this is where per-session avg HRV (ms), lowest/avg HR (bpm),
-- and phase durations come from. raw_oura_daily holds the day-level rollup; this holds detail.
-- Natural key: (subject_id, sleep_id).
-- day convention (2026-05-25): main sleeps (long_sleep / sleep) keep Oura's wake-date; naps and
-- short rests (late_nap / nap / rest) are re-keyed by the Worker to the LOCAL date they actually
-- occurred. Oura returns an evening nap with the *upcoming* wake-date (e.g. a 5/24 19:45 late_nap
-- as day=5/25), which the Worker corrects via bedtime_end (see workers/oura/src/shape.ts
-- correctSleepDays). raw_oura_daily never sources HRV/RHR/sleep_* from a nap (pickMainSleepByDay).
-- Idempotent load: MERGE on (subject_id, sleep_id); a re-keyed nap UPDATEs day in place.
-- NOTE (Phase 1 Worker): the daily-score endpoints (/daily_sleep, /daily_readiness) do NOT
-- carry HRV in ms or RHR in bpm — those live here. The Worker must also pull /sleep to
-- populate hrv_avg_ms / rhr_low_bpm / rhr_avg_bpm in raw_oura_daily.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_sleep (
  subject_id       INT64   NOT NULL,
  day              DATE    NOT NULL,            -- wake date (main); actual local date (naps/rest)
  sleep_id         STRING  NOT NULL,            -- Oura session id
  type             STRING,                      -- long_sleep | sleep | late_nap | nap | rest | deleted
  bedtime_start    TIMESTAMP,
  bedtime_end      TIMESTAMP,
  total_sleep_h    FLOAT64,
  time_in_bed_h    FLOAT64,
  deep_sleep_h     FLOAT64,
  rem_sleep_h      FLOAT64,
  light_sleep_h    FLOAT64,
  awake_h          FLOAT64,
  efficiency_pct   FLOAT64,
  latency_min      FLOAT64,
  avg_hrv_ms       FLOAT64,
  hr_lowest_bpm    FLOAT64,
  hr_avg_bpm       FLOAT64,
  avg_breath_rate  FLOAT64,
  restless_periods INT64,
  readiness_score  INT64,
  source           STRING  NOT NULL,            -- 'oura_api' | 'oura_csv_backfill'
  raw_json         JSON,
  ingested_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, sleep_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (
  description = "Per-session Oura sleep detail. Source of HRV(ms) & RHR(bpm). Cornerstone Phase 1."
);
