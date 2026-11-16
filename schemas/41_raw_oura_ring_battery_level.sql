-- raw_oura_ring_battery_level — Oura ring battery samples, ONE ROW PER SAMPLE (sparse, ~hourly).
-- Source: Oura v2 /v2/usercollection/ring_battery_level (added 2026-07-16 in the "no data unharvested"
--   sweep — the one collection endpoint the worker didn't cover; legacy /tag was the other gap but is
--   deprecated + fully superseded by enhanced_tag, so it stays intentionally unharvested).
-- Like /heartrate, this endpoint ranges by start_datetime/end_datetime (NOT start_date/end_date).
-- Natural key: (subject_id, ts). Idempotent load: MERGE on (subject_id, ts).
-- day = DATE(ts,'America/New_York') — partition key only, computed in the MERGE INSERT.
-- timestamp_unix (ms) from the API is intentionally dropped: redundant with ts.
-- raw_json intentionally absent: typed cols fully capture {timestamp, level, charging, in_charger}.
-- Consumer angle: charge-cycle hygiene ("ring died mid-night" explains missing sleep data), charging
--   windows as non-wear markers, battery-health degradation trend over ring lifetime.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_ring_battery_level (
  subject_id  INT64     NOT NULL,            -- constant 1 (the owner) today; future-proofs a second subject
  day         DATE      NOT NULL,            -- DATE(ts,'America/New_York'); partition key only
  ts          TIMESTAMP NOT NULL,            -- sample instant, stored UTC (Oura `timestamp`)
  level       INT64,                         -- battery percentage [0, 100]
  charging    BOOL,                          -- ring was actively charging
  in_charger  BOOL,                          -- ring was sitting in the charger
  source      STRING    NOT NULL,            -- provenance = 'oura' (matches raw_oura_heartrate)
  ingested_at TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, ts) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (
  description = "Oura ring battery level samples (/v2/usercollection/ring_battery_level). One row per sample. Charge-cycle hygiene + non-wear detection. Cornerstone."
);
