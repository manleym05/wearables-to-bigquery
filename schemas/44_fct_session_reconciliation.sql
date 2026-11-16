-- fct_session_reconciliation — did the logged session actually contain the prescribed work?
-- One row per logged workout.
--
-- WHY: a workout's title is not evidence of what was trained. A session can carry the exact
-- pushed-routine title and contain something else entirely — core and calisthenics under an
-- "Upper" heading, say. Trusting the title makes that split read as TRAINED when it was not, and
-- a progression ledger downstream will book a session that never happened.
--
-- THE RULE: trust exercise CONTENTS, never the title.
--   overlap = |actual ∩ planned| / |planned|            (matched on Hevy exercise_template_id)
--   as_planned   overlap >= 0.6
--   modified     0.2 <= overlap < 0.6
--   substituted  overlap < 0.2   ← the title is not to be trusted
--   unplanned    no pushed routine to compare against
-- `effective_split` is the ONLY field downstream consumers should credit toward a training split. On
-- `substituted` / `unplanned` it is 'unknown' — the weekly classifies it by hand rather than the
-- progression ledger booking a session that did not happen.
--
-- PLAN LOOKUP + THE 2-DAY WINDOW: raw_hevy_workout carries no routine_id, so a logged session is matched
-- to the most recent SUCCESSFUL hevy_push_routine in life_ops.action_log with target_date in [day−2, day].
-- The window is required, not defensive: a routine pushed for a Monday is often logged on the Tuesday.
-- A same-day-only join would score that real, on-plan session as
-- `unplanned`, which is the same class of error in the opposite direction.
--
-- MATCHING IS ON template_id, NOT TITLE. "Pull Up" (1B2B1E7C) and "Pull Up (Assisted)" (2C37EC5E) are
-- different exercises and must not fuzzy-match — assisted pull-ups on a day that prescribed weighted
-- pull-ups is exactly the substitution this view exists to catch.

CREATE OR REPLACE VIEW life_ops.fct_session_reconciliation AS
WITH actual AS (
  -- distinct exercises actually logged, per workout
  SELECT
    w.subject_id,
    w.workout_id,
    w.day,
    w.title,
    w.start_at,
    w.total_volume_lb,
    w.set_count,
    ARRAY_AGG(DISTINCT s.exercise_template_id IGNORE NULLS) AS actual_tids,
    ARRAY_AGG(DISTINCT s.exercise_title       IGNORE NULLS) AS actual_exercises
  FROM life_ops.raw_hevy_workout w
  JOIN life_ops.raw_hevy_set s
    ON s.subject_id = w.subject_id AND s.workout_id = w.workout_id
  GROUP BY w.subject_id, w.workout_id, w.day, w.title, w.start_at, w.total_volume_lb, w.set_count
),
pushes AS (
  -- every successful routine push, flattened to its prescribed template ids
  SELECT
    a.subject_id,
    a.target_date,
    a.ts,
    JSON_VALUE(a.payload_json, '$.input.training_day') AS planned_training_day,
    JSON_VALUE(a.payload_json, '$.hevy_body.title')    AS planned_title,
    ARRAY(
      SELECT JSON_VALUE(e, '$.exercise_template_id')
      FROM UNNEST(JSON_QUERY_ARRAY(a.payload_json, '$.hevy_body.exercises')) e
      WHERE JSON_VALUE(e, '$.exercise_template_id') IS NOT NULL
    ) AS planned_tids
  FROM life_ops.action_log a
  WHERE a.action_type = 'hevy_push_routine'
    AND a.status = 'success'
),
matched AS (
  -- Most recent push in [day−2, day]; ties broken by latest write. LEFT JOIN + QUALIFY rather than a
  -- correlated ORDER BY/LIMIT subquery — BigQuery cannot de-correlate the latter.
  SELECT
    ac.*,
    p.planned_training_day,
    p.planned_title,
    p.planned_tids,
    p.target_date AS plan_target_date
  FROM actual ac
  LEFT JOIN pushes p
    ON p.subject_id = ac.subject_id
   AND p.target_date BETWEEN DATE_SUB(ac.day, INTERVAL 2 DAY) AND ac.day
   AND ARRAY_LENGTH(p.planned_tids) > 0
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY ac.subject_id, ac.workout_id
    ORDER BY p.target_date DESC, p.ts DESC
  ) = 1
),
claimed AS (
  -- A pushed routine can be fulfilled by AT MOST ONE logged session. Without this, a genuine unplanned
  -- session can reach back and match an already-fulfilled earlier plan, scoring `substituted`
  -- against a routine it
  -- had nothing to do with. It is `unplanned`, and the distinction matters: `substituted` accuses the
  -- session of wearing a false label; `unplanned` just says no plan existed.
  --
  -- The claim goes to the best-fitting session: exact-date match first, then highest overlap, then
  -- earliest start. Losers keep their exercises but lose the plan (→ n_planned NULL → 'unplanned').
  SELECT
    m.* EXCEPT (planned_training_day, planned_title, planned_tids, plan_target_date),
    IF(keeps_plan, planned_training_day, NULL) AS planned_training_day,
    IF(keeps_plan, planned_title,        NULL) AS planned_title,
    IF(keeps_plan, planned_tids,         NULL) AS planned_tids,
    IF(keeps_plan, plan_target_date,     NULL) AS plan_target_date
  FROM (
    SELECT
      m.*,
      planned_tids IS NULL OR ROW_NUMBER() OVER (
        PARTITION BY subject_id, plan_target_date, planned_title
        ORDER BY
          IF(day = plan_target_date, 0, 1),                                          -- same-day wins
          (SELECT COUNT(DISTINCT t) FROM UNNEST(planned_tids) t
            WHERE t IN UNNEST(actual_tids)) DESC,                                    -- then best overlap
          start_at                                                                    -- then earliest
      ) = 1 AS keeps_plan
    FROM matched m
  ) m
),
tmpl AS (
  SELECT exercise_template_id, ANY_VALUE(primary_muscle_group) AS pmg
  FROM life_ops.raw_hevy_exercise_template
  WHERE primary_muscle_group IS NOT NULL
  GROUP BY exercise_template_id
),
planned_muscles AS (
  SELECT c.subject_id, c.workout_id, ARRAY_AGG(DISTINCT t.pmg IGNORE NULLS) AS pmgs
  FROM claimed c
  CROSS JOIN UNNEST(c.planned_tids) AS tid
  JOIN tmpl t ON t.exercise_template_id = tid
  GROUP BY c.subject_id, c.workout_id
),
actual_muscles AS (
  SELECT c.subject_id, c.workout_id, ARRAY_AGG(DISTINCT t.pmg IGNORE NULLS) AS pmgs
  FROM claimed c
  CROSS JOIN UNNEST(c.actual_tids) AS tid
  JOIN tmpl t ON t.exercise_template_id = tid
  GROUP BY c.subject_id, c.workout_id
),
scored AS (
  SELECT
    c.*,
    ARRAY_LENGTH(c.planned_tids) AS n_planned,
    -- self-referential UNNEST only (no other table) — this one de-correlates fine
    (SELECT COUNT(DISTINCT t) FROM UNNEST(c.planned_tids) t
      WHERE t IN UNNEST(c.actual_tids)) AS n_matched,
    -- muscle-group overlap (diagnostic — see the SELECT below for why it is not a classifier input).
    -- Resolved via the pm/am CTEs rather than inline subqueries: a correlated subquery that touches
    -- another table cannot be de-correlated by BigQuery.
    SAFE_DIVIDE(
      (SELECT COUNT(*) FROM UNNEST(pm.pmgs) g WHERE g IN UNNEST(am.pmgs)),
      NULLIF(ARRAY_LENGTH(pm.pmgs), 0)
    ) AS muscle_overlap
  FROM claimed c
  LEFT JOIN planned_muscles pm ON pm.subject_id = c.subject_id AND pm.workout_id = c.workout_id
  LEFT JOIN actual_muscles  am ON am.subject_id = c.subject_id AND am.workout_id = c.workout_id
)
SELECT
  subject_id,
  day,
  workout_id,
  title                                   AS logged_title,
  start_at,
  total_volume_lb,
  set_count,
  actual_exercises,
  actual_tids,
  planned_training_day,
  planned_title,
  plan_target_date,
  planned_tids,
  n_planned,
  n_matched,
  ROUND(SAFE_DIVIDE(n_matched, n_planned), 3) AS overlap,
  -- DIAGNOSTIC ONLY — deliberately NOT part of match_quality. Same-muscle overlap tells the weekly
  -- WHY a session gets flagged: swapping Front Squat for Barbell Squat is a real session with different
  -- equipment (low exact overlap, high muscle overlap), whereas core and calisthenics logged under an
  -- Upper title is not. Muscle overlap must not feed the classifier: push-ups and assisted pull-ups map
  -- to chest/lats, so a muscle-group rule would score the second case as on-plan and reintroduce the
  -- exact bug this view exists to close.
  ROUND(muscle_overlap, 3) AS primary_muscle_overlap,
  CASE
    WHEN n_planned IS NULL OR n_planned = 0        THEN 'unplanned'
    WHEN SAFE_DIVIDE(n_matched, n_planned) >= 0.6  THEN 'as_planned'
    WHEN SAFE_DIVIDE(n_matched, n_planned) >= 0.2  THEN 'modified'
    ELSE 'substituted'
  END AS match_quality,
  -- The ONLY field a consumer may credit toward a split. A substituted or unplanned session emits
  -- 'unknown' so the progression ledger cannot book a session that did not happen.
  CASE
    WHEN n_planned IS NULL OR n_planned = 0        THEN 'unknown'
    WHEN SAFE_DIVIDE(n_matched, n_planned) >= 0.2  THEN planned_training_day
    ELSE 'unknown'
  END AS effective_split,
  -- true when the logged title claims a plan the contents do not support.
  (planned_title IS NOT NULL
     AND title = planned_title
     AND COALESCE(SAFE_DIVIDE(n_matched, n_planned), 0) < 0.2) AS title_misleading,
  'hevy×action_log' AS source
FROM scored;
