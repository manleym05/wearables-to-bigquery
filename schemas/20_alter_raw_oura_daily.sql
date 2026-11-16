-- Enrichment: add typed columns to raw_oura_daily for fields we were dropping into raw_json.
-- - calorie + MET totals from /daily_activity day-level rollup
-- - sedentary / non-wear time
-- - per-endpoint contributor sub-scores as JSON columns
-- IF NOT EXISTS makes this idempotent.

ALTER TABLE life_ops.raw_oura_daily
  ADD COLUMN IF NOT EXISTS active_calories          INT64,
  ADD COLUMN IF NOT EXISTS total_calories           INT64,
  ADD COLUMN IF NOT EXISTS avg_met_minutes          FLOAT64,
  ADD COLUMN IF NOT EXISTS sedentary_min            INT64,
  ADD COLUMN IF NOT EXISTS non_wear_min             INT64,
  ADD COLUMN IF NOT EXISTS resting_time_min         INT64,
  ADD COLUMN IF NOT EXISTS high_activity_min        INT64,
  ADD COLUMN IF NOT EXISTS medium_activity_min      INT64,
  ADD COLUMN IF NOT EXISTS low_activity_min         INT64,
  ADD COLUMN IF NOT EXISTS equivalent_walking_m     FLOAT64,
  ADD COLUMN IF NOT EXISTS temperature_trend_dev_c  FLOAT64,
  ADD COLUMN IF NOT EXISTS sleep_contributors_json  JSON,
  ADD COLUMN IF NOT EXISTS readiness_contributors_json JSON,
  ADD COLUMN IF NOT EXISTS activity_contributors_json  JSON;
