-- raw_oura_daily — one row per day, denormalized Oura daily trend record.
-- Sources: Oura v2 /daily_sleep + /daily_readiness + /daily_activity (live API),
--          and the 408-day Oura Trends CSV export (one-time backfill).
-- Natural key: (subject_id, day). day = WAKE date (Oura default convention).
-- Idempotent load: MERGE on (subject_id, day) — re-running a pull overwrites the day's row.
-- raw_json holds the full vendor payload for fidelity (NULL for CSV-backfilled rows).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_daily (
  subject_id          INT64   NOT NULL,            -- constant 1 (the owner) today; future-proofs a second subject
  day                 DATE    NOT NULL,            -- wake date
  rhr_low_bpm         FLOAT64,                     -- resting HR, lowest during sleep
  rhr_avg_bpm         FLOAT64,                     -- average resting HR
  hrv_avg_ms          FLOAT64,                     -- average HRV (rMSSD), ms
  sleep_total_h       FLOAT64,
  sleep_deep_h        FLOAT64,
  sleep_rem_h         FLOAT64,
  sleep_light_h       FLOAT64,
  sleep_efficiency_pct FLOAT64,
  sleep_score         INT64,                       -- /daily_sleep score
  readiness_score     INT64,                       -- /daily_readiness score
  activity_score      INT64,                       -- /daily_activity score
  steps               INT64,
  respiratory_rate    FLOAT64,
  body_temp_dev_c     FLOAT64,                     -- /daily_readiness temperature_deviation
  source              STRING  NOT NULL,            -- 'oura_api' | 'oura_csv_backfill'
  source_id           STRING,                      -- vendor record id where available
  raw_json            JSON,                        -- full payload (NULL for CSV backfill)
  ingested_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (
  description = "Daily Oura trend record (sleep/readiness/activity). Wake-date keyed. Cornerstone Phase 1."
);
