-- raw_oura_session — Oura v2 /usercollection/session
-- Meditation, breathwork, naps logged in Oura.
-- Natural key: (subject_id, session_id). Time-series arrays (heart_rate, hrv, motion_count) stay in raw_json.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_session (
  subject_id       INT64    NOT NULL,
  day              DATE     NOT NULL,
  session_id       STRING   NOT NULL,
  type             STRING,                 -- 'meditation' | 'breathing' | 'relaxation' | 'rest' | 'nap'
  mood             STRING,                 -- post-session mood tag
  start_datetime   TIMESTAMP,
  end_datetime     TIMESTAMP,
  source           STRING   NOT NULL,
  raw_json         JSON,                   -- full payload incl. per-5-sec heart_rate / hrv / motion arrays
  ingested_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, session_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Oura sessions (meditation/breathing/nap). Time-series in raw_json. Cornerstone Phase 1.");
