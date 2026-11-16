-- Seed targets with YOUR goals. The values below are illustrative — replace them.
-- Idempotent: MERGE on (subject_id, effective_date, metric).
--
-- Targets are versioned by effective_date. When a target changes, append a NEW row
-- with a later effective_date rather than editing an existing one — that way the
-- daily views can answer "what was I aiming at on this date?" correctly.

MERGE life_ops.targets T
USING (
  SELECT * FROM UNNEST([
    STRUCT(1 AS subject_id, DATE '2026-01-01' AS effective_date, 'calories_intake' AS metric, 2500.0 AS value, 'kcal' AS unit, 'example — replace' AS note),
    STRUCT(1, DATE '2026-01-01', 'protein_g',       150.0, 'g',      'example — replace'),
    STRUCT(1, DATE '2026-01-01', 'fat_g',            80.0, 'g',      'example — replace'),
    STRUCT(1, DATE '2026-01-01', 'carbs_g',         280.0, 'g',      'example — replace'),
    STRUCT(1, DATE '2026-01-01', 'fiber_g',          35.0, 'g',      'example — replace'),
    STRUCT(1, DATE '2026-01-01', 'weight_trend_lb', 170.0, 'lb',     'example — replace'),
    STRUCT(1, DATE '2026-01-01', 'z2_minutes',      150.0, 'min/wk', 'example — replace')
  ])
) S
ON T.subject_id = S.subject_id AND T.effective_date = S.effective_date AND T.metric = S.metric
WHEN MATCHED THEN UPDATE SET
  value = S.value, unit = S.unit, note = S.note, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (subject_id, effective_date, metric, value, unit, note, updated_at)
VALUES
  (S.subject_id, S.effective_date, S.metric, S.value, S.unit, S.note, CURRENT_TIMESTAMP());
