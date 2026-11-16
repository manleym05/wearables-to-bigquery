// cornerstone-calendar — token-authed Google Calendar WRITE facade, scope-locked to the dedicated
// "Life HQ – Daily Plan" calendar. The brain's `calendar_write` tool calls this (via a Service
// Binding) so the brain never holds Google creds. Mirrors cornerstone-bq-query's shape.
//
// Routes (all except /healthz and / require ?token= or Authorization: Bearer ADMIN_TOKEN):
//   GET  /healthz                 -> "ok"
//   POST /write  { target_date, blocks[], calendar_id?, dry_run? }
//        Idempotent per-day: delete all events tagged lifehq_planned=true + lifehq_day=<date>,
//        then insert the new blocks (re-stamped). Real meetings (untagged) are never touched.
//   GET  /list?date=YYYY-MM-DD     -> the agent-owned events currently on that day
//   GET  /events?date=YYYY-MM-DD&calendar=<id>?
//        -> read-only: every event on the day with its LIVE (user-dragged) ET time + lifehq tags,
//           for the brain's re-plan pin-detection. Never mutates.

import type { Env } from "./env";
import { getGcpAccessToken } from "./jwt";
import { listAgentEvents, listEventsInRange, deleteEvent, insertEvent, addDays, type AgentBlock } from "./gcal";
import { HttpError } from "./errors";

const USAGE = [
  "cornerstone-calendar — write facade for the dedicated 'Life HQ – Daily Plan' calendar only.",
  "  GET  /healthz",
  "  POST /write  { target_date, blocks[], kind?:planned|actual, calendar_id?, dry_run? }  (Bearer ADMIN_TOKEN)",
  "  GET  /list?date=YYYY-MM-DD                                       (agent-owned events for a day)",
  "  GET  /events?date=YYYY-MM-DD&calendar=<id>?                      (read-only: live ET times + lifehq tags, for pin-detection)",
  "  POST /purge-legacy?from=…&to=…&dry_run=false                     ONE-TIME: delete legacy prototype events (dry-run default)",
  "  POST /sweep-planned?from=…&to=…&dry_run=false                    backfill sweep: purge superseded PLANNED blocks on days",
  "        that already have actuals. dry-run default; reports per-day counts incl. zeros.",
].join("\n");

function checkAuth(env: Env, url: URL, req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

// Constant-time string compare (length may leak; contents may not).
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(USAGE, { status: 200, headers: { "content-type": "text/plain" } });
    }

    const denied = checkAuth(env, url, req);
    if (denied) return denied;

    try {
      if (url.pathname === "/write") {
        if (req.method !== "POST") throw new HttpError(405, "/write requires POST");
        return await handleWrite(req, env);
      }
      if (url.pathname === "/list") return await handleList(env, url);
      if (url.pathname === "/events") return await handleEvents(env, url);
      if (url.pathname === "/purge-legacy") return await handlePurgeLegacy(env, url);
      if (url.pathname === "/sweep-planned") return await handleSweepPlanned(env, url);
      return new Response("not found — try /healthz, /write, /list, /events, /purge-legacy", { status: 404 });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return new Response(`calendar op failed: ${(err as Error).message}`, { status });
    }
  },
};

interface WriteBody { target_date?: string; calendar_id?: string; blocks?: unknown; dry_run?: boolean; kind?: string }

async function handleWrite(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as WriteBody | null;
  if (!body) throw new HttpError(400, "body must be JSON");

  const targetDate = body.target_date ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new HttpError(400, "target_date must be YYYY-MM-DD");

  // SCOPE LOCK — defense-in-depth alongside the brain-side check. This worker writes ONE calendar.
  const calId = body.calendar_id ?? env.CALENDAR_ID;
  if (calId !== env.CALENDAR_ID) {
    throw new HttpError(403, `scope-lock: cornerstone-calendar only writes the dedicated calendar; refused '${calId}'`);
  }

  if (!Array.isArray(body.blocks)) throw new HttpError(400, "blocks must be an array");
  if (body.blocks.length > 50) throw new HttpError(400, "too many blocks (max 50)");
  const blocks = body.blocks.map(validateBlock);
  const dryRun = body.dry_run === true;
  const kind = body.kind ?? "planned";
  if (kind !== "planned" && kind !== "actual") throw new HttpError(400, "kind must be 'planned' or 'actual'");

  const token = await getGcpAccessToken(env.GCP_SA_KEY);
  const existing = await listAgentEvents(calId, targetDate, token, kind);

  if (dryRun) {
    return json({
      ok: true, dry_run: true, target_date: targetDate, kind, calendar_id: calId,
      would_delete: existing.map((e) => ({ id: e.id, summary: e.summary })),
      would_insert: blocks.map((b) => ({ summary: b.summary, start: b.start, end: b.end, colorId: b.colorId })),
    });
  }

  // Wipe then rewrite (idempotent per day). Best-effort; collect per-op errors rather than aborting.
  const errors: string[] = [];
  let deleted = 0;
  for (const e of existing) {
    try { await deleteEvent(calId, e.id, token); deleted++; }
    catch (err) { errors.push(`delete ${e.id}: ${(err as Error).message}`); }
  }
  const eventIds: string[] = [];
  for (const b of blocks) {
    try { eventIds.push(await insertEvent(calId, targetDate, env.TIMEZONE, b, token, kind)); }
    catch (err) { errors.push(`insert '${b.summary}': ${(err as Error).message}`); }
  }
  return json(
    { ok: errors.length === 0, target_date: targetDate, kind, calendar_id: calId, deleted, inserted: eventIds.length, event_ids: eventIds, errors },
    errors.length ? 207 : 200,
  );
}

async function handleList(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date=YYYY-MM-DD required");
  const kindParam = url.searchParams.get("kind") ?? undefined; // optional planned|actual; omit ⇒ all kinds
  if (kindParam && kindParam !== "planned" && kindParam !== "actual") throw new HttpError(400, "kind must be 'planned' or 'actual'");
  const token = await getGcpAccessToken(env.GCP_SA_KEY);
  const events = await listAgentEvents(env.CALENDAR_ID, date, token, kindParam);
  return json({ ok: true, date, kind: kindParam ?? "all", calendar_id: env.CALENDAR_ID, count: events.length, events });
}

// /events — READ-ONLY view of every event on a day with its LIVE (possibly user-dragged) time, in
// ET wall-clock, plus its lifehq_kind/type tags. The brain's re-plan pin-detection (v1.1) calls this
// to see where the owner has manually moved a planned block since the last render. Distinct from /list:
// /list filters to agent-owned events and omits end/type; this returns the full day (planned +
// actual + real meetings) with start_et+end_et+kind+type so the caller can diff against the stored
// plan. Touches NOTHING — no write, no wipe — so it's projection-safe.
async function handleEvents(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date=YYYY-MM-DD required");
  // Optional ?calendar= — scope-locked to the dedicated calendar (mirrors /write's defense-in-depth;
  // read-only, but no reason to ever read another calendar through this worker).
  const calId = url.searchParams.get("calendar") ?? env.CALENDAR_ID;
  if (calId !== env.CALENDAR_ID) {
    throw new HttpError(403, `scope-lock: cornerstone-calendar only reads the dedicated calendar; refused '${calId}'`);
  }
  const token = await getGcpAccessToken(env.GCP_SA_KEY);
  const all = await listEventsInRange(calId, date, date, token);
  const events = all.map((e) => ({
    summary: e.summary ?? "",
    start_et: toEtHHMM(e.start, env.TIMEZONE),
    end_et: toEtHHMM(e.end, env.TIMEZONE),
    lifehq_kind: e.lifehq_kind ?? null,
    lifehq_type: e.lifehq_type ?? null,
  }));
  return json({ ok: true, date, calendar_id: calId, count: events.length, events });
}

/** RFC3339 dateTime (carries the event's UTC offset) → "HH:MM" ET wall-clock. Robust to whatever
 *  offset Google returns (planned blocks are stored in ET, but parse-then-format-in-tz is exact for
 *  any source tz). All-day events have a bare `date` (no "T") → null (no wall-clock time). */
function toEtHHMM(dt: string | undefined, tz: string): string | null {
  if (!dt || !dt.includes("T")) return null;
  const ms = Date.parse(dt);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(ms));
}

// /purge-legacy — ONE-TIME cutover cleanup. Deletes hand-built prototype events
// (description marker "[Life HQ …]", carrying NO lifehq_kind) so the brain's regenerated events
// don't duplicate them. Scope-locked to the dedicated calendar; dry_run defaults TRUE (opt out to
// actually delete). The filter never matches new agent events (all carry lifehq_kind) or anything
// else — precise to the prototypes.
async function handlePurgeLegacy(env: Env, url: URL): Promise<Response> {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HttpError(400, "from + to (YYYY-MM-DD) required");
  }
  const dryRun = url.searchParams.get("dry_run") !== "false";
  const token = await getGcpAccessToken(env.GCP_SA_KEY);
  const all = await listEventsInRange(env.CALENDAR_ID, from, to, token);
  const legacy = all.filter((e) => (e.description ?? "").includes("[Life HQ") && !e.lifehq_kind);

  if (dryRun) {
    return json({
      ok: true, dry_run: true, from, to, scanned: all.length, legacy_count: legacy.length,
      legacy: legacy.map((e) => ({ id: e.id, summary: e.summary, start: e.start })),
    });
  }
  const errors: string[] = [];
  let deleted = 0;
  for (const e of legacy) {
    try { await deleteEvent(env.CALENDAR_ID, e.id, token); deleted++; }
    catch (err) { errors.push(`${e.id}: ${(err as Error).message}`); }
  }
  return json({ ok: errors.length === 0, from, to, deleted, errors }, errors.length ? 207 : 200);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// /sweep-planned — the range backfill sweep (Life HQ item filed 2026-06-28, built 2026-07-26).
//
// PROBLEM IT FIXES: `runActualize` purges a day's `planned` layer only for the dates it is actually
// called with. Any day the cron missed keeps its superseded plan blocks forever, and nothing sweeps
// backwards — so the weekly de-duplicates by hand every week.
//
// ⚠️ THE ACTUALS GATE IS THE SAFETY PROPERTY, NOT A REFINEMENT. A planned block is only stale once
// the day has actually happened and been actualized. Purging by date alone would delete FUTURE plans —
// turning a cleanup tool into the most destructive thing in the system. So a date is swept ONLY if it
// already carries `kind='actual'` events. A day with plans and no actuals is left completely alone and
// reported as `skipped_no_actuals`, which is also the honest answer for "did the actualize never run
// here?".
//
// ⚠️ REPORTS WHAT IT PURGED, PER DAY, INCLUDING ZEROS. Life HQ retracted a finding on 2026-07-26
// precisely because "zero plan blocks now" could not be distinguished from "there were never any plan
// blocks". Every swept date returns its planned count, its actual count, and the summaries of what was
// deleted — so "removed 12 stale blocks" and "there were none" are never the same output again.
//
// dry_run defaults TRUE. Scope-locked to the dedicated calendar, `kind='planned'` only — `actual`
// events and real meetings are never candidates.
async function handleSweepPlanned(env: Env, url: URL): Promise<Response> {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HttpError(400, "from + to (YYYY-MM-DD) required");
  }
  if (from > to) throw new HttpError(400, "from must be <= to");
  // Bounded so a typo'd range can't turn into a thousand-day scan.
  const MAX_DAYS = 120;
  const dryRun = url.searchParams.get("dry_run") !== "false";
  // Escape hatch for the rare "I know this day is stale but it has no actuals" case. Off by default.
  const requireActuals = url.searchParams.get("require_actuals") !== "false";

  const token = await getGcpAccessToken(env.GCP_SA_KEY);
  const days: Array<{
    date: string; planned: number; actual: number;
    action: "purged" | "would_purge" | "skipped_no_actuals" | "nothing_to_purge";
    deleted: Array<{ id: string; summary?: string }>;
  }> = [];
  const errors: string[] = [];
  let totalDeleted = 0;

  for (let d = from, i = 0; d <= to && i < MAX_DAYS; d = addDays(d, 1), i++) {
    const planned = await listAgentEvents(env.CALENDAR_ID, d, token, "planned");
    const actual = requireActuals ? await listAgentEvents(env.CALENDAR_ID, d, token, "actual") : [];

    if (planned.length === 0) {
      days.push({ date: d, planned: 0, actual: actual.length, action: "nothing_to_purge", deleted: [] });
      continue;
    }
    if (requireActuals && actual.length === 0) {
      // Plans exist but the day was never actualized — LEAVE IT. Could be a future day, or a day the
      // cron missed. Either way this tool must not be the thing that decides it's stale.
      days.push({ date: d, planned: planned.length, actual: 0, action: "skipped_no_actuals", deleted: [] });
      continue;
    }

    const summaries = planned.map((e) => ({ id: e.id, summary: e.summary }));
    if (dryRun) {
      days.push({ date: d, planned: planned.length, actual: actual.length, action: "would_purge", deleted: summaries });
      continue;
    }
    let deleted = 0;
    for (const e of planned) {
      try { await deleteEvent(env.CALENDAR_ID, e.id, token); deleted++; }
      catch (err) { errors.push(`${d} ${e.id}: ${(err as Error).message}`); }
    }
    totalDeleted += deleted;
    days.push({ date: d, planned: planned.length, actual: actual.length, action: "purged", deleted: summaries });
    // Structured line per swept day — Workers Logs is the durable record until cornerstone-calendar
    // is wired into life_ops.action_log like the other action workers.
    console.log(JSON.stringify({ kind: "sweep_planned", date: d, deleted, actual: actual.length }));
  }

  const swept = days.filter((x) => x.action === "purged" || x.action === "would_purge");
  return json({
    ok: errors.length === 0,
    dry_run: dryRun,
    from, to,
    days_scanned: days.length,
    days_with_stale_plans: swept.length,
    events_deleted: dryRun ? 0 : totalDeleted,
    events_would_delete: dryRun ? swept.reduce((n, x) => n + x.planned, 0) : 0,
    days_skipped_no_actuals: days.filter((x) => x.action === "skipped_no_actuals").map((x) => x.date),
    days,                       // full per-day detail, including the zeros
    errors,
  }, errors.length ? 207 : 200);
}

function validateBlock(raw: unknown): AgentBlock {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "each block must be an object");
  const b = raw as Record<string, unknown>;
  if (typeof b.summary !== "string" || !b.summary) throw new HttpError(400, "block.summary required");
  if (typeof b.start !== "string" || !/^(\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(:\d{2})?)$/.test(b.start)) throw new HttpError(400, `block.start must be HH:MM (got '${String(b.start)}')`);
  if (typeof b.end !== "string" || !/^(\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(:\d{2})?)$/.test(b.end)) throw new HttpError(400, `block.end must be HH:MM (got '${String(b.end)}')`);
  if (b.colorId != null && !/^([1-9]|1[01])$/.test(String(b.colorId))) throw new HttpError(400, "block.colorId must be '1'..'11'");
  return {
    type: typeof b.type === "string" ? b.type : "other",
    summary: b.summary,
    start: b.start,
    end: b.end,
    colorId: b.colorId != null ? String(b.colorId) : undefined,
    description: typeof b.description === "string" ? b.description : undefined,
    drive_time_min: typeof b.drive_time_min === "number" ? b.drive_time_min : undefined,
  };
}
