-- raw_maps_directions — Google Maps Directions API cache.
-- Populated on-demand by the cornerstone-maps Worker. No backfill, no cron.
-- Natural cache key: SHA-256 of (origin, destination, mode, departure_hour, day_type).
-- Lookups: WHERE cache_key = ? AND cached_until > CURRENT_TIMESTAMP() ORDER BY requested_at DESC LIMIT 1.
-- Multiple rows for the same cache_key are allowed (history of refreshes) — lookup picks latest valid.
-- Default TTL: 30 days (configurable via CACHE_TTL_DAYS env var).

CREATE TABLE IF NOT EXISTS life_ops.raw_maps_directions (
  subject_id              INT64    NOT NULL,
  cache_key               STRING   NOT NULL,            -- sha256(origin|destination|mode|departure_hour|day_type)
  origin                  STRING   NOT NULL,
  destination             STRING   NOT NULL,
  mode                    STRING   NOT NULL,            -- 'driving' | 'walking' | 'bicycling' | 'transit'
  departure_hour          INT64    NOT NULL,            -- 0..23 in user TZ
  day_type                STRING   NOT NULL,            -- 'weekday' | 'weekend'
  departure_time_used     TIMESTAMP,                    -- the actual future timestamp sent to Maps
  duration_s              INT64,                        -- free-flow duration
  duration_text           STRING,
  duration_in_traffic_s   INT64,                        -- with traffic_model=best_guess (driving only)
  duration_in_traffic_text STRING,
  distance_m              INT64,
  distance_text           STRING,
  start_address           STRING,                       -- Maps' geocoded resolution of origin
  end_address             STRING,
  start_lat               FLOAT64,
  start_lng               FLOAT64,
  end_lat                 FLOAT64,
  end_lng                 FLOAT64,
  route_summary           STRING,                       -- e.g. "I-71 N"
  polyline                STRING,                       -- encoded overview polyline
  warnings_json           JSON,
  copyrights              STRING,
  source                  STRING   NOT NULL,            -- 'google_maps'
  raw_json                JSON,
  requested_at            TIMESTAMP NOT NULL,
  cached_until            TIMESTAMP NOT NULL
)
PARTITION BY DATE(requested_at)
CLUSTER BY subject_id, cache_key
OPTIONS (description = "Google Maps Directions cache. Populated on-demand by cornerstone-maps Worker. Cornerstone Phase 1.");
