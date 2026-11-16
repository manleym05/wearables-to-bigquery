// Minimal Google Calendar REST client for Workers — events.list (filtered by privateExtendedProperty),
// events.insert, events.delete. The caller supplies the calendar id (the router scope-locks it to
// CALENDAR_ID first). Retries transient failures (429/5xx/network); a 404/410 on delete is treated
// as success (the event is already gone → idempotent).

import { HttpError } from "./errors";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const MAX_RETRIES = 3;

export interface AgentBlock {
  type: string;
  summary: string;
  start: string;            // "HH:MM" local wall-time
  end: string;              // "HH:MM" local wall-time
  colorId?: string;         // "1".."11"
  description?: string;
  drive_time_min?: number;  // appended to the description when present
}

export interface AgentEventRef {
  id: string;
  summary?: string;
  start?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gcalFetch(url: string, init: RequestInit): Promise<Response> {
  let delay = 400;
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = `network: ${(e as Error).message}`;
      if (attempt === MAX_RETRIES) break;
      await sleep(delay); delay = Math.min(delay * 2, 4000); continue;
    }
    if (res.ok || res.status === 404 || res.status === 410) return res; // 404/410 ⇒ already gone
    if (res.status === 429 || res.status >= 500) {
      lastErr = `gcal ${res.status}: ${await res.text()}`;
      if (attempt === MAX_RETRIES) break;
      await sleep(delay); delay = Math.min(delay * 2, 4000); continue;
    }
    // Non-retryable (400 bad event, 401/403 auth/share missing) — surface with detail.
    throw new HttpError(502, `gcal ${res.status}: ${await res.text()}`);
  }
  throw new HttpError(502, `gcal request failed after ${MAX_RETRIES + 1} attempts: ${lastErr}`);
}

interface GCalListResponse {
  items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string } }>;
}

/** List agent-owned events for `date`. With `kind`, narrows to that layer (planned|actual) so a
 *  wipe touches only its own kind; without it, returns ALL agent events for the day (any kind). */
export async function listAgentEvents(calId: string, date: string, accessToken: string, kind?: string): Promise<AgentEventRef[]> {
  const qs = new URLSearchParams({ singleEvents: "true", showDeleted: "false", maxResults: "250" });
  if (kind) qs.append("privateExtendedProperty", `lifehq_kind=${kind}`);
  qs.append("privateExtendedProperty", `lifehq_day=${date}`);
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`;
  const res = await gcalFetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = (await res.json()) as GCalListResponse;
  return (json.items ?? []).map((e) => ({ id: e.id, summary: e.summary, start: e.start?.dateTime ?? e.start?.date }));
}

export interface FullEventRef { id: string; summary?: string; start?: string; end?: string; description?: string; lifehq_kind?: string; lifehq_type?: string }

/** List ALL events in a date range (incl. start+end, description, lifehq_kind+type). Unlike
 *  listAgentEvents there's no privateExtendedProperty filter — so it FINDS everything on the day:
 *  the old description-tagged prototype events (no lifehq_kind, for /purge-legacy) AND the current
 *  planned/actual layers WITH their live (possibly user-dragged) times, for /events pin-detection. */
export async function listEventsInRange(calId: string, fromDate: string, toDate: string, accessToken: string): Promise<FullEventRef[]> {
  const qs = new URLSearchParams({
    singleEvents: "true", showDeleted: "false", maxResults: "250", orderBy: "startTime",
    // ET-day window (EDT -04:00) so it covers the FULL local day incl. evening/overnight blocks
    // (wind-down ~21:00, sleep ~21:30 → next morning). A UTC window ended at 20:00 ET and MISSED
    // them, leaving skeleton wind-down/sleep dups uncleared by the per-day purge. (EST shifts this
    // ~1h earlier — still catches the evening; revisit exactness at the Nov DST change.)
    timeMin: `${fromDate}T00:00:00-04:00`, timeMax: `${addDays(toDate, 1)}T00:00:00-04:00`,
  });
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`;
  const res = await gcalFetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = (await res.json()) as { items?: Array<{ id: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; extendedProperties?: { private?: Record<string, string> } }> };
  return (json.items ?? []).map((e) => ({
    id: e.id, summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date,
    description: e.description,
    lifehq_kind: e.extendedProperties?.private?.lifehq_kind,
    lifehq_type: e.extendedProperties?.private?.lifehq_type,
  }));
}

export async function deleteEvent(calId: string, eventId: string, accessToken: string): Promise<void> {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`;
  await gcalFetch(url, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
}

/** Insert one agent block; returns the new event id. */
export async function insertEvent(
  calId: string, date: string, tz: string, block: AgentBlock, accessToken: string, kind: string,
): Promise<string> {
  const desc = block.drive_time_min != null
    ? `${block.description ?? ""}${block.description ? " " : ""}(~${block.drive_time_min} min drive)`.trim()
    : (block.description ?? "");
  const dt = blockDateTimes(date, block.start, block.end);
  const body: Record<string, unknown> = {
    summary: block.summary,
    description: desc,
    // dateTime carries NO offset; `timeZone` makes Google resolve it (DST-correct, per the API).
    start: { dateTime: dt.startDt, timeZone: tz },
    end: { dateTime: dt.endDt, timeZone: tz },
    extendedProperties: { private: { lifehq_kind: kind, lifehq_day: date, lifehq_type: block.type } },
    transparency: "transparent",      // plan overlay — never marks the owner "busy" in freeBusy
    reminders: { useDefault: false }, // no notification spam from ~12 plan blocks/day
  };
  if (block.colorId) body.colorId = block.colorId;
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calId)}/events`;
  const res = await gcalFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id: string };
  return json.id;
}

const FULL_DT = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(:\d{2})?$/;

/** Resolve a block's start/end into local datetimes. A block carries EITHER "HH:MM" (combined with
 *  the day's target_date; the end rolls past midnight when end ≤ start, e.g. 22:30→06:00) OR an
 *  explicit "YYYY-MM-DDTHH:MM[:SS]" local datetime, used as-is — for actuals like the sleep block
 *  whose start is the previous evening. Both halves of a block use the same form. */
function blockDateTimes(date: string, start: string, end: string): { startDt: string; endDt: string } {
  if (FULL_DT.test(start)) {
    return { startDt: withSeconds(start), endDt: FULL_DT.test(end) ? withSeconds(end) : `${date}T${padHHMM(end)}:00` };
  }
  const endDay = hhmmMin(end) <= hhmmMin(start) ? addDays(date, 1) : date;
  return { startDt: `${date}T${padHHMM(start)}:00`, endDt: `${endDay}T${padHHMM(end)}:00` };
}
function withSeconds(dt: string): string { return /T\d{1,2}:\d{2}$/.test(dt) ? `${dt}:00` : dt; }
function padHHMM(hhmm: string): string { const [h, m] = hhmm.split(":"); return `${h.padStart(2, "0")}:${m}`; }
function hhmmMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
