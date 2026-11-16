// Cornerstone — Calendar ingestion via Google Apps Script.
// Runs as you@example.com. Writes to your-gcp-project.life_ops.raw_calendar_events.
// Per arch doc §3: Apps Script (not a CF Worker) because the built-in CalendarApp + BigQuery
// advanced services + user-as-self auth eliminate the OAuth complexity.

const SUBJECT_ID    = 1;
const PROJECT_ID    = 'your-gcp-project';
const DATASET       = 'life_ops';
const TARGET_TABLE  = 'raw_calendar_events';
const TIMEZONE      = 'America/New_York';

// Three calendars per Life HQ/pipelines/calendar-classification.md.
// work is freeBusyReader — Calendar.Events.list returns redacted entries (busy blocks only).
const CALENDAR_IDS = [
  'you@example.com',     // the owner personal (owner)
  'partner@example.com',        // a second subject's (reader)
  'you-work@example.com',   // work calendar (freeBusyReader — busy only)
];

const TRAILING_DAYS  = 30;   // catch retroactive edits to past events
const LOOKAHEAD_DAYS = 90;   // forward window for planning queries

// ===== Triggers =====

// Cadence bumped 2026-05-27 (Life HQ handoff 2026-05-26 PM3): the adaptive-agent wake-render
// workflow needs fresher calendar data than 1×/day. Hourly runs are well within Apps Script
// free-tier quotas (~12 min runtime/day, 24 BQ writes/day vs 90 min/50K caps).
// Function names kept as `dailyRun` / `installTrigger` for backwards compat; only the cadence changed.

/** Hourly trigger handler — install via installTrigger() once. */
function dailyRun() {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - TRAILING_DAYS);
  const end   = new Date(now); end.setDate(now.getDate() + LOOKAHEAD_DAYS);
  const counts = ingest_(start, end);
  Logger.log('dailyRun done: ' + JSON.stringify(counts));
}

/** One-time full historical backfill. Run manually from the editor. */
function backfillFull() {
  const start = new Date('2024-01-01T00:00:00Z');
  const end   = new Date();
  end.setDate(end.getDate() + 365);
  const counts = ingest_(start, end);
  Logger.log('backfillFull done: ' + JSON.stringify(counts));
}

/** Setup helper — installs the hourly trigger. Run once (or re-run to swap cadence). */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRun')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('installed dailyRun trigger every 1 hour');
}

// ===== Ingest =====

function ingest_(startDate, endDate) {
  const ingestedAt = new Date().toISOString();
  const rows = [];
  const counts = {};
  for (const calId of CALENDAR_IDS) {
    const calSummary = tryGetCalendarSummary_(calId);
    const events = fetchEvents_(calId, startDate, endDate);
    counts[calId] = events.length;
    for (const e of events) {
      const row = buildRow_(e, calId, calSummary, ingestedAt);
      if (row) rows.push(row);
    }
  }
  if (rows.length > 0) loadAndMerge_(rows);
  counts.total_rows = rows.length;
  return counts;
}

function tryGetCalendarSummary_(calendarId) {
  try {
    return Calendar.CalendarList.get(calendarId).summary || null;
  } catch (e) {
    Logger.log('warn: cannot get summary for ' + calendarId + ': ' + e);
    return null;
  }
}

function fetchEvents_(calendarId, startDate, endDate) {
  const events = [];
  let pageToken = undefined;
  for (let i = 0; i < 200; i++) {  // safety cap
    let resp;
    try {
      resp = Calendar.Events.list(calendarId, {
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,    // expand recurring → one row per instance
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken: pageToken,
        showDeleted: false,
      });
    } catch (e) {
      Logger.log('error listing events for ' + calendarId + ': ' + e);
      break;
    }
    if (resp.items) events.push.apply(events, resp.items);
    pageToken = resp.nextPageToken;
    if (!pageToken) break;
  }
  return events;
}

function buildRow_(e, calendarId, calendarSummary, ingestedAt) {
  if (!e.id) return null;

  const startAtIso = e.start && (e.start.dateTime || (e.start.date ? e.start.date + 'T00:00:00Z' : null));
  const endAtIso   = e.end   && (e.end.dateTime   || (e.end.date   ? e.end.date   + 'T00:00:00Z' : null));
  const isAllDay = !!(e.start && e.start.date && !e.start.dateTime);

  // local-tz day for partitioning
  const dayLocal = e.start && e.start.date
    ? e.start.date
    : (startAtIso ? Utilities.formatDate(new Date(startAtIso), TIMEZONE, 'yyyy-MM-dd') : '1970-01-01');

  let durationMin = null;
  if (startAtIso && endAtIso) {
    durationMin = Math.round((new Date(endAtIso).getTime() - new Date(startAtIso).getTime()) / 60000);
  }

  const attendees = e.attendees || [];
  const selfAttendee = attendees.filter(function (a) { return a.self; })[0];

  return {
    subject_id: SUBJECT_ID,
    event_id: e.id,
    calendar_id: calendarId,
    calendar_summary: calendarSummary,
    ical_uid: e.iCalUID || null,
    recurring_event_id: e.recurringEventId || null,
    title: e.summary || null,
    description: e.description || null,
    location: e.location || null,
    status: e.status || null,
    transparency: e.transparency || 'opaque',
    visibility: e.visibility || 'default',
    is_all_day: isAllDay,
    start_at: startAtIso,
    end_at: endAtIso,
    start_date: (e.start && e.start.date) || null,
    end_date:   (e.end   && e.end.date)   || null,
    day: dayLocal,
    duration_min: durationMin,
    timezone: (e.start && e.start.timeZone) || null,
    attendee_count: attendees.length,
    self_response_status: (selfAttendee && selfAttendee.responseStatus) || null,
    creator_email:   (e.creator && e.creator.email) || null,
    organizer_email: (e.organizer && e.organizer.email) || null,
    attendees_json: attendees.length > 0 ? JSON.stringify(attendees) : null,
    conference_solution: (e.conferenceData && e.conferenceData.conferenceSolution && e.conferenceData.conferenceSolution.name) || null,
    conference_data_json: e.conferenceData ? JSON.stringify(e.conferenceData) : null,
    color_id: e.colorId || null,
    created_at: e.created || null,
    updated_at: e.updated || null,
    source: 'google_calendar',
    raw_json: JSON.stringify(e),
    ingested_at: ingestedAt,
  };
}

// ===== BigQuery: load NDJSON → staging → MERGE target → drop staging =====

function loadAndMerge_(rows) {
  const suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const stagingTable = '_staging_calendar_events_' + suffix;

  try {
    // 1. Load
    const ndjson = rows.map(function (r) { return JSON.stringify(r); }).join('\n');
    const loadJob = BigQuery.Jobs.insert(
      {
        configuration: {
          load: {
            destinationTable: { projectId: PROJECT_ID, datasetId: DATASET, tableId: stagingTable },
            sourceFormat: 'NEWLINE_DELIMITED_JSON',
            writeDisposition: 'WRITE_TRUNCATE',
            createDisposition: 'CREATE_IF_NEEDED',
            schema: { fields: STAGING_SCHEMA },
            ignoreUnknownValues: false,
          },
        },
      },
      PROJECT_ID,
      Utilities.newBlob(ndjson, 'application/octet-stream'),
    );
    waitForJob_(loadJob.jobReference);

    // 2. MERGE
    const mergeSql = buildMergeSql_(stagingTable);
    const mergeJob = BigQuery.Jobs.query(
      { query: mergeSql, useLegacySql: false, timeoutMs: 60000 },
      PROJECT_ID,
    );
    if (mergeJob.jobReference) waitForJob_(mergeJob.jobReference);
  } finally {
    // 3. Drop staging (best-effort)
    try { BigQuery.Tables.remove(PROJECT_ID, DATASET, stagingTable); }
    catch (e) { Logger.log('warn: could not drop ' + stagingTable + ': ' + e); }
  }
}

function waitForJob_(jobRef) {
  const deadline = Date.now() + 180000;   // 3 min
  let delay = 1000;
  while (Date.now() < deadline) {
    const job = BigQuery.Jobs.get(jobRef.projectId, jobRef.jobId, { location: jobRef.location });
    if (job.status && job.status.state === 'DONE') {
      if (job.status.errorResult) {
        throw new Error('bq job failed: ' + job.status.errorResult.message);
      }
      return;
    }
    Utilities.sleep(delay);
    delay = Math.min(delay * 1.5, 4000);
  }
  throw new Error('bq job did not complete within 3 min');
}

function buildMergeSql_(stagingTable) {
  const T = '`' + PROJECT_ID + '.' + DATASET + '.' + TARGET_TABLE + '`';
  const S = '`' + PROJECT_ID + '.' + DATASET + '.' + stagingTable + '`';
  return [
    'MERGE ' + T + ' U',
    'USING (',
    '  SELECT * FROM ' + S,
    '  QUALIFY ROW_NUMBER() OVER (PARTITION BY subject_id, calendar_id, event_id ORDER BY ingested_at DESC) = 1',
    ') S',
    'ON U.subject_id = S.subject_id AND U.calendar_id = S.calendar_id AND U.event_id = S.event_id',
    'WHEN MATCHED THEN UPDATE SET',
    '  calendar_summary = S.calendar_summary, ical_uid = S.ical_uid, recurring_event_id = S.recurring_event_id,',
    '  title = S.title, description = S.description, location = S.location,',
    '  status = S.status, transparency = S.transparency, visibility = S.visibility,',
    '  is_all_day = S.is_all_day, start_at = S.start_at, end_at = S.end_at,',
    '  start_date = S.start_date, end_date = S.end_date, day = S.day, duration_min = S.duration_min,',
    '  timezone = S.timezone, attendee_count = S.attendee_count,',
    '  self_response_status = S.self_response_status,',
    '  creator_email = S.creator_email, organizer_email = S.organizer_email,',
    '  attendees_json = S.attendees_json,',
    '  conference_solution = S.conference_solution, conference_data_json = S.conference_data_json,',
    '  color_id = S.color_id, created_at = S.created_at, updated_at = S.updated_at,',
    '  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at',
    'WHEN NOT MATCHED THEN INSERT (',
    '  subject_id, event_id, calendar_id, calendar_summary, ical_uid, recurring_event_id,',
    '  title, description, location, status, transparency, visibility,',
    '  is_all_day, start_at, end_at, start_date, end_date, day, duration_min,',
    '  timezone, attendee_count, self_response_status,',
    '  creator_email, organizer_email, attendees_json,',
    '  conference_solution, conference_data_json, color_id,',
    '  created_at, updated_at, source, raw_json, ingested_at',
    ') VALUES (',
    '  S.subject_id, S.event_id, S.calendar_id, S.calendar_summary, S.ical_uid, S.recurring_event_id,',
    '  S.title, S.description, S.location, S.status, S.transparency, S.visibility,',
    '  S.is_all_day, S.start_at, S.end_at, S.start_date, S.end_date, S.day, S.duration_min,',
    '  S.timezone, S.attendee_count, S.self_response_status,',
    '  S.creator_email, S.organizer_email, S.attendees_json,',
    '  S.conference_solution, S.conference_data_json, S.color_id,',
    '  S.created_at, S.updated_at, S.source, S.raw_json, S.ingested_at',
    ')',
  ].join('\n');
}

const STAGING_SCHEMA = [
  { name: 'subject_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'event_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'calendar_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'calendar_summary', type: 'STRING' },
  { name: 'ical_uid', type: 'STRING' },
  { name: 'recurring_event_id', type: 'STRING' },
  { name: 'title', type: 'STRING' },
  { name: 'description', type: 'STRING' },
  { name: 'location', type: 'STRING' },
  { name: 'status', type: 'STRING' },
  { name: 'transparency', type: 'STRING' },
  { name: 'visibility', type: 'STRING' },
  { name: 'is_all_day', type: 'BOOL' },
  { name: 'start_at', type: 'TIMESTAMP' },
  { name: 'end_at', type: 'TIMESTAMP' },
  { name: 'start_date', type: 'DATE' },
  { name: 'end_date', type: 'DATE' },
  { name: 'day', type: 'DATE', mode: 'REQUIRED' },
  { name: 'duration_min', type: 'INT64' },
  { name: 'timezone', type: 'STRING' },
  { name: 'attendee_count', type: 'INT64' },
  { name: 'self_response_status', type: 'STRING' },
  { name: 'creator_email', type: 'STRING' },
  { name: 'organizer_email', type: 'STRING' },
  { name: 'attendees_json', type: 'JSON' },
  { name: 'conference_solution', type: 'STRING' },
  { name: 'conference_data_json', type: 'JSON' },
  { name: 'color_id', type: 'STRING' },
  { name: 'created_at', type: 'TIMESTAMP' },
  { name: 'updated_at', type: 'TIMESTAMP' },
  { name: 'source', type: 'STRING', mode: 'REQUIRED' },
  { name: 'raw_json', type: 'JSON' },
  { name: 'ingested_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
];
