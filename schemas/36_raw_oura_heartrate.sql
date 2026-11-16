-- raw_oura_heartrate — Oura intraday heart rate, ONE ROW PER SAMPLE (minute-grain).
-- Source: Oura v2 /v2/usercollection/heartrate (live API only — the sample series has no CSV path).
--   ⚠️ This endpoint ranges by start_datetime/end_datetime (ISO datetime), NOT the start_date/end_date
--      the other 14 Oura endpoints use. High-frequency series → datetime windowing + next_token paging.
-- Natural key: (subject_id, ts). One bpm per instant. Idempotent load: MERGE on (subject_id, ts).
-- day = DATE(ts,'America/New_York') — PARTITION KEY ONLY (a pruning convenience). This is the ET
--   calendar date of the sample, NOT Oura wake-date semantics: heartrate is a continuous series,
--   never sleep-attributed. Computed in the MERGE INSERT so `ts` stays the single source of truth.
-- Grain rationale: long/narrow per-sample rows (not a JSON array in raw_json like _sleep/_session) because
--   the consumer math — overnight nadir timing, time-in-HR-zone, meeting-window attribution — wants
--   queryable rows, not an UNNEST on every read. Partition+cluster keeps each consumer query a 1-partition scan.
-- raw_json: optional/unpopulated by default — the three typed cols fully capture {bpm,source,timestamp};
--   storing the blob per sample would ~double a high-volume table for zero fidelity gain. Kept in schema
--   for shape parity + future byte-fidelity opt-in.
-- Spec: Life HQ/pipelines/oura-heartrate-ingestion.md (build-ready handoff 2026-05-31).
-- Note: physical `source` = 'oura' per spec (the metrics_daily view-layer vendor label). Sibling raw_oura_*
--   tables physically store 'oura_api' (an API-vs-CSV provenance marker); nothing reads this column on
--   heartrate and metrics_daily relabels to 'oura' anyway, so the two reconcile at the view layer.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_heartrate (
  subject_id  INT64     NOT NULL,            -- constant 1 (the owner) today; future-proofs a second subject
  day         DATE      NOT NULL,            -- DATE(ts,'America/New_York'); partition key only (see header)
  ts          TIMESTAMP NOT NULL,            -- sample instant, stored UTC (Oura `timestamp`, ISO8601 w/ offset)
  bpm         INT64,                         -- heart rate, beats per minute (Oura `bpm`)
  hr_source   STRING,                        -- Oura per-sample context: awake|rest|sleep|session|live|workout
  source      STRING    NOT NULL,            -- provenance = 'oura'
  raw_json    JSON,                          -- optional; NULL by default (typed cols already capture all 3 fields)
  ingested_at TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, ts) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (
  description = "Oura intraday heart rate (minute-grain, /v2/usercollection/heartrate). One row per sample. Unlocks cross-signal synergy #1 (strain/Z2), #2 overnight HR curve, #3 (stress x calendar). Cornerstone — spec: Life HQ/pipelines/oura-heartrate-ingestion.md."
);
