-- raw_withings_sleep — Withings /v2/sleep?action=getsummary (one row per night).
-- Natural key: (subject_id, sleep_id). day = the sleep summary's wake-date.

CREATE TABLE IF NOT EXISTS life_ops.raw_withings_sleep (
  subject_id                       INT64    NOT NULL,
  sleep_id                         STRING   NOT NULL,           -- Withings id (stringified)
  day                              DATE     NOT NULL,
  startdate                        TIMESTAMP,
  enddate                          TIMESTAMP,
  total_sleep_h                    FLOAT64,
  asleep_h                         FLOAT64,
  deep_sleep_h                     FLOAT64,
  light_sleep_h                    FLOAT64,
  rem_sleep_h                      FLOAT64,
  awake_h                          FLOAT64,
  time_in_bed_h                    FLOAT64,
  sleep_efficiency_pct             FLOAT64,
  sleep_score                      INT64,
  withings_index                   FLOAT64,
  sleep_latency_min                FLOAT64,
  wakeup_latency_min               FLOAT64,
  wakeup_count                     INT64,
  waso_min                         FLOAT64,
  nb_rem_episodes                  INT64,
  out_of_bed_count                 INT64,
  hr_avg_bpm                       FLOAT64,
  hr_min_bpm                       FLOAT64,
  hr_max_bpm                       FLOAT64,
  hrv_avg_ms                       FLOAT64,
  hrv_lowest_ms                    FLOAT64,
  rr_avg                           FLOAT64,
  rr_min                           FLOAT64,
  rr_max                           FLOAT64,
  breathing_disturbances_intensity FLOAT64,
  snoring_episode_count            INT64,
  snoring_s                        INT64,
  apnea_hypopnea_index             FLOAT64,
  timezone                         STRING,
  model                            STRING,
  model_id                         INT64,
  device_id_hash                   STRING,
  source                           STRING   NOT NULL,
  raw_json                         JSON,
  ingested_at                      TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, sleep_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Withings nightly sleep summary (mat / watch). Cornerstone Phase 1.");
