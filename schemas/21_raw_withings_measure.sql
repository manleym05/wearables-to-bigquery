-- raw_withings_measure — Withings /measure?action=getmeas (pivoted measure groups).
-- One row per measuregrp (a single "session" — e.g. stepping on the scale captures multiple types).
-- Natural key: (subject_id, grpid). Withings grpid is stable per measurement event.

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_measure (
  subject_id              INT64    NOT NULL,
  grpid                   INT64    NOT NULL,           -- Withings measuregrp id
  measured_at             TIMESTAMP NOT NULL,
  day                     DATE     NOT NULL,           -- local date (America/New_York)
  weight_kg               FLOAT64,
  height_m                FLOAT64,
  fat_free_mass_kg        FLOAT64,
  fat_ratio_pct           FLOAT64,
  fat_mass_kg             FLOAT64,
  muscle_mass_kg          FLOAT64,
  hydration_kg            FLOAT64,
  bone_mass_kg            FLOAT64,
  bp_diastolic_mmhg       FLOAT64,
  bp_systolic_mmhg        FLOAT64,
  heart_pulse_bpm         FLOAT64,
  spo2_pct                FLOAT64,
  body_temp_c             FLOAT64,
  skin_temp_c             FLOAT64,
  pulse_wave_velocity_m_s FLOAT64,
  vo2_max                 FLOAT64,
  vascular_age_years      FLOAT64,
  afib_result             INT64,
  nerve_health            FLOAT64,
  attrib                  INT64,                       -- 0=device auto, 1/2=ambiguous, 4/5=manual, 7=manual confirm
  category                INT64,                       -- 1=real, 2=user objective
  device_id               STRING,
  source                  STRING   NOT NULL,           -- 'withings_api'
  raw_json                JSON,
  ingested_at             TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, grpid) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Withings measurements (weight, body comp, BP, HR pulse, SpO2, etc.). Pivoted by meastype. Cornerstone Phase 1.");
