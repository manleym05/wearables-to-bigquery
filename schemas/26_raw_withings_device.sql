-- raw_withings_device — Withings /v2/user?action=getdevice (devices linked to account).
-- One row per device, refreshed each cron tick. Natural key: (subject_id, device_id_hash).

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_device (
  subject_id        INT64    NOT NULL,
  device_id_hash    STRING   NOT NULL,
  type              STRING,
  model             STRING,
  model_id          INT64,
  battery           STRING,
  timezone          STRING,
  first_session_at  TIMESTAMP,
  last_session_at   TIMESTAMP,
  source            STRING   NOT NULL,
  raw_json          JSON,
  ingested_at       TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, device_id_hash) NOT ENFORCED
)
CLUSTER BY subject_id
OPTIONS (description = "Withings devices snapshot (scale, watch, BP cuff). Cornerstone Phase 1.");
