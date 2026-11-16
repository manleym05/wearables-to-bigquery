-- raw_oura_enhanced_tag — Oura v2 /usercollection/enhanced_tag
-- User-applied tags (caffeine, alcohol, sick, nap, etc.). Causal signals for HRV/sleep outliers.
-- Natural key: (subject_id, tag_id). Tags can span multiple days (start_day → end_day).

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_enhanced_tag (
  subject_id       INT64    NOT NULL,
  start_day        DATE     NOT NULL,
  tag_id           STRING   NOT NULL,
  tag_type_code    STRING,              -- e.g. 'tag_generic_nap', 'tag_generic_caffeine_late'
  custom_name      STRING,              -- user-defined name for custom tags
  comment          STRING,
  start_time       TIMESTAMP,
  end_time         TIMESTAMP,           -- nullable (point-in-time tags)
  end_day          DATE,                -- nullable
  source           STRING   NOT NULL,
  raw_json         JSON,
  ingested_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, tag_id) NOT ENFORCED
)
PARTITION BY start_day
CLUSTER BY subject_id
OPTIONS (description = "User-applied Oura tags. Causal signals for biometric outliers. Cornerstone Phase 1.");
