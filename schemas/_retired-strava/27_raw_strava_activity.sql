-- raw_strava_activity — Strava v3 /athlete/activities (per-activity summaries).
-- Natural key: (subject_id, activity_id). Activities arrive with full HR/cadence/power summary;
-- per-second streams + per-activity HR-zone time-in-zone are deferred (defer per arch doc §3 HR-volume rule).

CREATE TABLE IF NOT EXISTS life_ops.raw_strava_activity (
  subject_id          INT64    NOT NULL,
  activity_id         INT64    NOT NULL,            -- Strava activity id
  day                 DATE     NOT NULL,            -- local wake-date of start_date_local
  external_id         STRING,                       -- e.g. Garmin file id
  upload_id           INT64,
  name                STRING,
  type                STRING,                       -- 'Run' | 'Ride' | 'Walk' | 'Hike' | 'Swim' | ...
  sport_type          STRING,
  workout_type        INT64,                        -- 0=default, 1=race, 2=long run, 3=workout (per type)
  start_at            TIMESTAMP,
  start_at_local      TIMESTAMP,
  timezone            STRING,                       -- e.g. "(GMT-05:00) America/New_York"
  utc_offset_s        INT64,
  distance_m          FLOAT64,
  moving_time_s       INT64,
  elapsed_time_s      INT64,
  elevation_gain_m    FLOAT64,
  elev_high_m         FLOAT64,
  elev_low_m          FLOAT64,
  avg_speed_m_s       FLOAT64,
  max_speed_m_s       FLOAT64,
  avg_cadence         FLOAT64,                      -- spm (running) or rpm (cycling)
  avg_temp_c          FLOAT64,
  avg_hr_bpm          FLOAT64,
  max_hr_bpm          FLOAT64,
  has_heartrate       BOOL,
  avg_watts           FLOAT64,
  max_watts           FLOAT64,
  weighted_avg_watts  FLOAT64,                      -- normalized power (cycling)
  device_watts        BOOL,                         -- true = measured by power meter, false = estimated
  kilojoules          FLOAT64,
  suffer_score        FLOAT64,                      -- "Relative Effort"
  calories            FLOAT64,
  start_lat           FLOAT64,
  start_lng           FLOAT64,
  end_lat             FLOAT64,
  end_lng             FLOAT64,
  gear_id             STRING,
  device_name         STRING,
  is_trainer          BOOL,
  is_commute          BOOL,
  is_manual           BOOL,
  is_private          BOOL,
  visibility          STRING,                       -- 'everyone' | 'followers_only' | 'only_me'
  pr_count            INT64,
  achievement_count   INT64,
  kudos_count         INT64,
  comment_count       INT64,
  athlete_count       INT64,
  photo_count         INT64,
  location_city       STRING,
  location_state      STRING,
  location_country    STRING,
  summary_polyline    STRING,                       -- encoded polyline (Google format)
  source              STRING   NOT NULL,            -- 'strava_api'
  raw_json            JSON,
  ingested_at         TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, activity_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "Strava activities (runs/rides/walks/hikes/swims). Per-activity HR/cadence/power summary. Cornerstone Phase 1.");
