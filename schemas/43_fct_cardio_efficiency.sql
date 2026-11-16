-- fct_cardio_efficiency — pace at equal cardiac cost, per cardio session.
--
-- WHY: most recovery signals in a stack like this are different views of the same HRV/HR series.
-- This one is not. It is a PERFORMANCE-side corroborator: if an autonomic decline is real, it
-- should also show up as work output falling at a fixed cardiac cost — the same route, the same
-- heart rate, a slower pace. A non-HRV-derived confirmation is worth more than another view of the
-- same series, because it cannot share HRV's failure modes (ring fit, nap contamination, scoring
-- changes).
--
-- TWO METRICS, deliberately:
--   - `pace_min_per_mi` bucketed into `hr_band` — the human-legible form. Comparable only WITHIN a
--     band, because pace-vs-HR is nonlinear.
--   - `m_per_beat` = distance / total beats — cardiac-cost-normalised efficiency. Band-free, so it
--     trends cleanly across sessions in different HR bands. The better regression input.
--
-- DISTANCE FLOOR (1.0 mi) IS LOAD-BEARING. Short walks produce nonsense paces: a sub-mile "walk" is
-- usually a stroll with stops and reads as an absurd min/mi. Sessions under a mile are excluded
-- rather than trended. Sessions with no HR samples are excluded too — a row with distance but no
-- cardiac cost reads as missing when it is actually just late-arriving data.
--
-- Baseline: trailing 90 days, SAME activity + SAME HR band, excluding the session itself.
-- `n_base_sessions` exposes how much evidence the comparison rests on — a delta measured against
-- one prior session is an anecdote, not a trend.
--
-- FILTER TO `activity='running'` FOR TREND WORK. Walks survive the distance floor but remain
-- unreliable: they contain stops, conversation and errands, so pace is not a repeatable test.

CREATE OR REPLACE VIEW life_ops.fct_cardio_efficiency AS
WITH sessions AS (
  SELECT
    s.subject_id,
    s.day,
    s.workout_id,
    s.activity,
    s.start_at,
    s.duration_min,
    w.distance_m,
    s.avg_bpm,
    s.max_bpm,
    s.n_hr_samples,
    s.strain_score,
    s.pct_in_z2,
    s.pct_above_z2,
    ROUND(w.distance_m / 1609.34, 3)                                   AS distance_mi,
    ROUND(SAFE_DIVIDE(s.duration_min, w.distance_m / 1609.34), 2)      AS pace_min_per_mi,
    -- metres covered per heartbeat: distance / (avg_bpm × minutes). Higher = more efficient.
    ROUND(SAFE_DIVIDE(w.distance_m, s.avg_bpm * s.duration_min), 4)    AS m_per_beat,
    -- 10-bpm bands. Z2 is the absolute band you set in fct_workout_strain.
    CAST(FLOOR(s.avg_bpm / 10) * 10 AS INT64)                          AS hr_band_low
  FROM life_ops.fct_workout_strain s
  JOIN life_ops.raw_oura_workout w
    ON w.subject_id = s.subject_id AND w.workout_id = s.workout_id
  WHERE s.is_cardio
    AND w.distance_m >= 1609.34        -- ≥ 1.0 mi; below this, pace is noise (see header)
    AND s.avg_bpm IS NOT NULL
    AND s.n_hr_samples > 0
    AND s.duration_min > 0
),
banded AS (
  SELECT
    *,
    CONCAT(CAST(hr_band_low AS STRING), '-', CAST(hr_band_low + 9 AS STRING), ' bpm') AS hr_band
  FROM sessions
),
based AS (
  SELECT
    b.*,
    -- trailing-90d, same activity + same HR band, EXCLUDING this session
    (SELECT AVG(x.pace_min_per_mi) FROM banded x
      WHERE x.subject_id = b.subject_id AND x.activity = b.activity
        AND x.hr_band_low = b.hr_band_low
        AND x.workout_id != b.workout_id
        AND x.day BETWEEN DATE_SUB(b.day, INTERVAL 90 DAY) AND b.day) AS pace_base_90d,
    (SELECT AVG(x.m_per_beat) FROM banded x
      WHERE x.subject_id = b.subject_id AND x.activity = b.activity
        AND x.workout_id != b.workout_id
        AND x.day BETWEEN DATE_SUB(b.day, INTERVAL 90 DAY) AND b.day) AS mpb_base_90d,
    (SELECT COUNT(*) FROM banded x
      WHERE x.subject_id = b.subject_id AND x.activity = b.activity
        AND x.hr_band_low = b.hr_band_low
        AND x.workout_id != b.workout_id
        AND x.day BETWEEN DATE_SUB(b.day, INTERVAL 90 DAY) AND b.day) AS n_base_sessions
  FROM banded b
)
SELECT
  subject_id, day, workout_id, activity, start_at,
  duration_min, distance_mi, avg_bpm, max_bpm, n_hr_samples,
  hr_band, hr_band_low,
  pace_min_per_mi,
  m_per_beat,
  strain_score, pct_in_z2, pct_above_z2,
  -- vs same-band baseline. POSITIVE pace delta = slower = worse.
  ROUND(pace_base_90d, 2)                              AS pace_base_90d,
  ROUND(SAFE_DIVIDE(pace_min_per_mi, pace_base_90d) - 1, 4) AS pace_vs_base_pct,
  -- vs activity baseline (band-free). NEGATIVE m/beat delta = less distance per heartbeat = worse.
  ROUND(mpb_base_90d, 4)                               AS mpb_base_90d,
  ROUND(SAFE_DIVIDE(m_per_beat, mpb_base_90d) - 1, 4)  AS mpb_vs_base_pct,
  n_base_sessions,
  'oura_workout' AS source
FROM based;
