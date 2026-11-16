-- profile_static — slowly-changing profile facts. One row per subject.
-- subject_id 1 = the owner. Future-proofs a second subject (subject_id 2) per arch doc.

CREATE TABLE IF NOT EXISTS life_ops.profile_static (
  subject_id    INT64  NOT NULL,
  display_name  STRING,
  dob           DATE,
  sex           STRING,                 -- 'M' | 'F'
  height_cm     FLOAT64,
  location      STRING,
  timezone      STRING,                 -- IANA tz; drives wake-date normalization
  updated_at    TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id) NOT ENFORCED
)
OPTIONS (
  description = "Static/slowly-changing profile. Cornerstone Phase 1."
);
