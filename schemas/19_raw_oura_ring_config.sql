-- raw_oura_ring_config — Oura v2 /usercollection/ring_configuration
-- Ring metadata (color, design, firmware, size). Natural key: (subject_id, ring_id).
-- Allows tracking ring upgrades / replacements.

CREATE TABLE IF NOT EXISTS life_ops.raw_oura_ring_config (
  subject_id        INT64    NOT NULL,
  ring_id           STRING   NOT NULL,
  color             STRING,
  design            STRING,
  hardware_type     STRING,            -- e.g. 'gen3' | 'gen4'
  firmware_version  STRING,
  size              INT64,
  set_up_at         TIMESTAMP,
  source            STRING   NOT NULL,
  raw_json          JSON,
  ingested_at       TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, ring_id) NOT ENFORCED
)
CLUSTER BY subject_id
OPTIONS (description = "Oura ring configuration. Multi-row to capture ring upgrades. Cornerstone Phase 1.");
