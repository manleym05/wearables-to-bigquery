-- targets — moving targets, effective-dated (append a new row when a target changes).
-- Query pattern: latest target for a metric = the row with MAX(effective_date) <= as_of.
-- Natural key: (subject_id, effective_date, metric).

CREATE TABLE IF NOT EXISTS life_ops.targets (
  subject_id      INT64  NOT NULL,
  effective_date  DATE   NOT NULL,
  metric          STRING NOT NULL,      -- canonical metric name (see metric dictionary)
  value           FLOAT64,
  unit            STRING,
  note            STRING,
  updated_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, effective_date, metric) NOT ENFORCED
)
PARTITION BY effective_date
CLUSTER BY subject_id, metric
OPTIONS (
  description = "Effective-dated targets (nutrition, weight, training). Cornerstone Phase 1."
);
