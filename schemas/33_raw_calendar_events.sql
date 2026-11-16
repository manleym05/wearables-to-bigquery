-- raw_calendar_events — Google Calendar events from all subscribed calendars.
-- Loaded by Apps Script daily at 1 AM (apps-script/calendar/Code.gs).
-- Three calendars per Life HQ/pipelines/calendar-classification.md:
--   you@example.com    — owner, full detail
--   partner@example.com       — reader, full detail (a second subject's calendar)
--   you-work@example.com  — freeBusyReader, busy blocks only (no title/attendees)
--
-- Classification (personal/work/a second subject/shared) is downstream in Life HQ — this table stores raw
-- events with calendar_id so consumers can apply their own classification rules.
--
-- Natural key: (subject_id, calendar_id, event_id). Recurring instances get distinct event_ids
-- with timestamp suffixes (singleEvents=true in fetch) so each instance MERGEs cleanly.

CREATE TABLE IF NOT EXISTS life_ops.raw_calendar_events (
  subject_id            INT64    NOT NULL,
  event_id              STRING   NOT NULL,
  calendar_id           STRING   NOT NULL,
  calendar_summary      STRING,
  ical_uid              STRING,
  recurring_event_id    STRING,                  -- parent event id (null for non-recurring)
  title                 STRING,                  -- null for freeBusy calendars
  description           STRING,
  location              STRING,
  status                STRING,                  -- 'confirmed' | 'tentative' | 'cancelled'
  transparency          STRING,                  -- 'opaque' (busy) | 'transparent' (free)
  visibility            STRING,                  -- 'default' | 'public' | 'private' | 'confidential'
  is_all_day            BOOL,
  start_at              TIMESTAMP,
  end_at                TIMESTAMP,
  start_date            DATE,                    -- non-null for all-day events
  end_date              DATE,
  day                   DATE     NOT NULL,       -- partition key; local-tz date of start
  duration_min          INT64,
  timezone              STRING,
  attendee_count        INT64,
  self_response_status  STRING,                  -- 'accepted' | 'declined' | 'tentative' | 'needsAction'
  creator_email         STRING,
  organizer_email       STRING,
  attendees_json        JSON,                    -- array of {email, displayName, responseStatus, self, organizer}
  conference_solution   STRING,                  -- 'Google Meet' | 'Zoom' | etc.
  conference_data_json  JSON,
  color_id              STRING,
  created_at            TIMESTAMP,
  updated_at            TIMESTAMP,
  source                STRING   NOT NULL,       -- 'google_calendar'
  raw_json              JSON,
  ingested_at           TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, calendar_id, event_id) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id, calendar_id
OPTIONS (description = "Google Calendar events from 3 calendars (personal/a second subject/work). Loaded by Apps Script daily. Cornerstone Phase 1.");
