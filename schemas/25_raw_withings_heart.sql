-- raw_withings_heart — Withings /v2/heart?action=list (ECG + cuff BP measurements).
-- No Oura-style `id` — natural key synthesized as "{deviceid}-{timestamp_epoch}".

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_heart (
  subject_id          INT64    NOT NULL,
  measurement_id      STRING   NOT NULL,             -- synthesized: "{deviceid}-{timestamp}"
  measured_at         TIMESTAMP NOT NULL,
  day                 DATE     NOT NULL,
  heart_rate_bpm      FLOAT64,
  ecg_signal_id       INT64,
  afib_classification INT64,                          -- 0=neg, 1=pos, 2=inconclusive
  bp_systolic_mmhg    FLOAT64,
  bp_diastolic_mmhg   FLOAT64,
  device_id           STRING,
  model               INT64,
  timezone            STRING,
  source              STRING   NOT NULL,
  raw_json            JSON,
  ingested_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, measurement_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Withings heart measurements (ECG screenings, BP cuff readings). Cornerstone Phase 1.");
