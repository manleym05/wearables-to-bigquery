import type { Env } from "./env";
import {
  getToken,
  loadJsonRows,
  runQuery,
  dropTable,
  DAILY_STAGING_SCHEMA,
  SLEEP_STAGING_SCHEMA,
  DAILY_STRESS_SCHEMA,
  DAILY_SPO2_SCHEMA,
  DAILY_RESILIENCE_SCHEMA,
  DAILY_CARDIO_AGE_SCHEMA,
  VO2_MAX_SCHEMA,
  WORKOUT_SCHEMA,
  SESSION_SCHEMA,
  ENHANCED_TAG_SCHEMA,
  REST_MODE_SCHEMA,
  SLEEP_TIME_SCHEMA,
  PERSONAL_INFO_SCHEMA,
  RING_CONFIG_SCHEMA,
  HEARTRATE_SCHEMA,
  RING_BATTERY_SCHEMA,
} from "./bq";
import {
  getDailySleep, getDailyReadiness, getDailyActivity, getSleep,
  getDailyStress, getDailySpo2, getDailyResilience, getDailyCardioAge,
  getVo2Max, getWorkout, getSession, getEnhancedTag, getRestModePeriod, getSleepTime,
  getPersonalInfo, getRingConfiguration, getHeartrate, getRingBatteryLevel,
} from "./oura";
import {
  buildDailyRows, buildSleepRows, correctSleepDays,
  buildDailyStressRows, buildDailySpo2Rows, buildDailyResilienceRows, buildDailyCardioAgeRows,
  buildVo2MaxRows, buildWorkoutRows, buildSessionRows, buildEnhancedTagRows,
  buildRestModePeriodRows, buildSleepTimeRows, buildPersonalInfoRow, buildRingConfigRows,
  buildHeartrateRows, buildRingBatteryRows,
} from "./shape";
import {
  dailyMergeSql, sleepMergeSql,
  dailyStressMergeSql, dailySpo2MergeSql, dailyResilienceMergeSql, dailyCardioAgeMergeSql,
  vo2MaxMergeSql, workoutMergeSql, sessionMergeSql, enhancedTagMergeSql,
  restModeMergeSql, sleepTimeMergeSql, personalInfoMergeSql, ringConfigMergeSql,
  heartrateMergeSql, ringBatteryMergeSql,
} from "./merge";
import { buildAuthorizeUrl, exchangeCodeForTokens, persistTokens, getOuraToken } from "./oauth";

const TRAILING_DAYS = 3;
// Query one day past "today" so the freshest wake-date session is always inside the window even
// at the day boundary / when Oura finalizes a session late. Future days simply return no data.
const LOOKAHEAD_DAYS = 1;
const KV_KEY_LAST_SEEN = "last_seen";
const KV_KEY_OAUTH_STATE_PREFIX = "oauth_state:";

// --- intraday heart rate ---
// HR is high-frequency (minute-grain) so it runs on its OWN daily cron, not the 30-min summary tick
// ("*/30 * * * *", wrangler crons[0]): a 48h re-pull every 30 min would hammer the Oura API + re-MERGE
// the same window 48x/day for no freshness gain (HR feeds offline cross-signal analysis, not the
// real-time card). HR_CRON MUST stay in sync with wrangler.toml [triggers].crons[1]. We match HR_CRON
// explicitly and let everything else fall through to the summary path, so a config drift degrades HR
// (loud: no rows land) without ever breaking the more critical every-30-min summary poll.
const HR_CRON = "17 10 * * *";          // ~06:17 ET daily — intraday HR incremental (wrangler crons[1])
const HR_INCREMENTAL_HOURS = 48;        // re-pull [now-48h, now]; the 24h overlap self-heals late samples
const HR_BACKFILL_CHUNK_DAYS = 7;       // chunk the one-time backfill into <=7-day windows (high-frequency)

interface IngestResult {
  start: string;
  end: string;
  counts: Record<string, number>;
}

interface TableSpec {
  short: string;       // log/result key (e.g. "daily_stress")
  table: string;       // BQ target table name
  schema: typeof DAILY_STAGING_SCHEMA;
  rows: object[];
  mergeSql: (project: string, dataset: string, stagingTable: string) => string;
}

async function ingest(env: Env, start: string, end: string): Promise<IngestResult> {
  const subjectId = Number(env.SUBJECT_ID);
  const ingestedAt = new Date().toISOString();

  // Resolve auth ONCE per invocation (OAuth access token, or PAT fallback during migration)
  // so a mid-run refresh can't hand different tokens to parallel pulls.
  const ouraToken = await getOuraToken(env);

  // All API pulls in parallel — they're independent
  const [
    sleepScores, readiness, activity, rawSleeps,
    stress, spo2, resilience, cardioAge,
    vo2max, workouts, sessions, tags, restMode, sleepTime,
    personalInfo, rings,
  ] = await Promise.all([
    getDailySleep(ouraToken, start, end),
    getDailyReadiness(ouraToken, start, end),
    getDailyActivity(ouraToken, start, end),
    getSleep(ouraToken, start, end),
    getDailyStress(ouraToken, start, end),
    getDailySpo2(ouraToken, start, end),
    getDailyResilience(ouraToken, start, end),
    getDailyCardioAge(ouraToken, start, end),
    getVo2Max(ouraToken, start, end),
    getWorkout(ouraToken, start, end),
    getSession(ouraToken, start, end),
    getEnhancedTag(ouraToken, start, end),
    getRestModePeriod(ouraToken, start, end),
    getSleepTime(ouraToken, start, end),
    getPersonalInfo(ouraToken),
    getRingConfiguration(ouraToken),
  ]);

  // Re-key evening naps off Oura's wake-date to the date they actually occurred (see shape.ts).
  const sleeps = correctSleepDays(rawSleeps, env.TIMEZONE);

  const specs: TableSpec[] = [
    { short: "daily",            table: "raw_oura_daily",              schema: DAILY_STAGING_SCHEMA,    rows: buildDailyRows(subjectId, sleepScores, readiness, activity, sleeps, ingestedAt), mergeSql: dailyMergeSql },
    { short: "sleep",            table: "raw_oura_sleep",              schema: SLEEP_STAGING_SCHEMA,    rows: buildSleepRows(subjectId, sleeps, ingestedAt),                                       mergeSql: sleepMergeSql },
    { short: "daily_stress",     table: "raw_oura_daily_stress",       schema: DAILY_STRESS_SCHEMA,     rows: buildDailyStressRows(subjectId, stress, ingestedAt),                                  mergeSql: dailyStressMergeSql },
    { short: "daily_spo2",       table: "raw_oura_daily_spo2",         schema: DAILY_SPO2_SCHEMA,       rows: buildDailySpo2Rows(subjectId, spo2, ingestedAt),                                      mergeSql: dailySpo2MergeSql },
    { short: "daily_resilience", table: "raw_oura_daily_resilience",   schema: DAILY_RESILIENCE_SCHEMA, rows: buildDailyResilienceRows(subjectId, resilience, ingestedAt),                          mergeSql: dailyResilienceMergeSql },
    { short: "daily_cardio_age", table: "raw_oura_daily_cardio_age",   schema: DAILY_CARDIO_AGE_SCHEMA, rows: buildDailyCardioAgeRows(subjectId, cardioAge, ingestedAt),                            mergeSql: dailyCardioAgeMergeSql },
    { short: "vo2_max",          table: "raw_oura_vo2_max",            schema: VO2_MAX_SCHEMA,          rows: buildVo2MaxRows(subjectId, vo2max, ingestedAt),                                       mergeSql: vo2MaxMergeSql },
    { short: "workout",          table: "raw_oura_workout",            schema: WORKOUT_SCHEMA,          rows: buildWorkoutRows(subjectId, workouts, ingestedAt),                                    mergeSql: workoutMergeSql },
    { short: "session",          table: "raw_oura_session",            schema: SESSION_SCHEMA,          rows: buildSessionRows(subjectId, sessions, ingestedAt),                                    mergeSql: sessionMergeSql },
    { short: "enhanced_tag",     table: "raw_oura_enhanced_tag",       schema: ENHANCED_TAG_SCHEMA,     rows: buildEnhancedTagRows(subjectId, tags, ingestedAt),                                    mergeSql: enhancedTagMergeSql },
    { short: "rest_mode",        table: "raw_oura_rest_mode_period",   schema: REST_MODE_SCHEMA,        rows: buildRestModePeriodRows(subjectId, restMode, ingestedAt),                             mergeSql: restModeMergeSql },
    { short: "sleep_time",       table: "raw_oura_sleep_time",         schema: SLEEP_TIME_SCHEMA,       rows: buildSleepTimeRows(subjectId, sleepTime, ingestedAt),                                 mergeSql: sleepTimeMergeSql },
    { short: "personal_info",    table: "raw_oura_personal_info",      schema: PERSONAL_INFO_SCHEMA,    rows: [buildPersonalInfoRow(subjectId, personalInfo, ingestedAt)],                          mergeSql: personalInfoMergeSql },
    { short: "ring_config",      table: "raw_oura_ring_config",        schema: RING_CONFIG_SCHEMA,      rows: buildRingConfigRows(subjectId, rings, ingestedAt),                                    mergeSql: ringConfigMergeSql },
  ];

  const token = await getToken(env.GCP_SA_KEY);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const counts: Record<string, number> = {};
  const stagingTables: { dataset: string; table: string }[] = [];

  try {
    // Run each table's load+MERGE in parallel — they touch independent targets.
    await Promise.all(
      specs.map(async (spec) => {
        counts[spec.short] = spec.rows.length;
        if (spec.rows.length === 0) return;
        const stagingTable = `_staging_${spec.table.replace(/^raw_oura_/, "oura_")}_${suffix}`;
        stagingTables.push({ dataset: env.BQ_DATASET, table: stagingTable });
        await loadJsonRows({
          projectId: env.GCP_PROJECT,
          datasetId: env.BQ_DATASET,
          tableId: stagingTable,
          rows: spec.rows,
          schema: spec.schema,
          accessToken: token,
        });
        await runQuery(env.GCP_PROJECT, spec.mergeSql(env.GCP_PROJECT, env.BQ_DATASET, stagingTable), token);
      }),
    );
  } finally {
    // Best-effort cleanup of all staging tables created this run.
    await Promise.allSettled(
      stagingTables.map((s) => dropTable(env.GCP_PROJECT, s.dataset, s.table, token)),
    );
  }

  return { start, end, counts };
}

// --- intraday heart rate ingest (separate path: datetime windowing + (subject_id, ts) MERGE) ---

interface HeartrateResult {
  start: string;
  end: string;
  count: number;
}

// Pull [startISO, endISO] of intraday HR, stage into a per-invocation staging table, MERGE on
// (subject_id, ts). Reuses the same load+MERGE+drop framework as the summary path.
async function ingestHeartrate(env: Env, startISO: string, endISO: string): Promise<HeartrateResult> {
  const subjectId = Number(env.SUBJECT_ID);
  const ingestedAt = new Date().toISOString();
  const ouraToken = await getOuraToken(env);
  const samples = await getHeartrate(ouraToken, startISO, endISO);
  const rows = buildHeartrateRows(subjectId, samples, ingestedAt);
  if (rows.length === 0) return { start: startISO, end: endISO, count: 0 };

  const token = await getToken(env.GCP_SA_KEY);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const stagingTable = `_staging_oura_heartrate_${suffix}`;
  try {
    await loadJsonRows({
      projectId: env.GCP_PROJECT,
      datasetId: env.BQ_DATASET,
      tableId: stagingTable,
      rows,
      schema: HEARTRATE_SCHEMA,
      accessToken: token,
    });
    await runQuery(
      env.GCP_PROJECT,
      heartrateMergeSql(env.GCP_PROJECT, env.BQ_DATASET, stagingTable, env.TIMEZONE),
      token,
    );
  } finally {
    await Promise.allSettled([dropTable(env.GCP_PROJECT, env.BQ_DATASET, stagingTable, token)]);
  }
  return { start: startISO, end: endISO, count: rows.length };
}

// --- ring battery level (same datetime-windowed shape as heartrate, far sparser) ---
// Rides the daily HR cron + the kind=hr backfill; a dedicated cron/kind would be overkill
// for a handful of samples per day.

async function ingestRingBattery(env: Env, startISO: string, endISO: string): Promise<HeartrateResult> {
  const subjectId = Number(env.SUBJECT_ID);
  const ingestedAt = new Date().toISOString();
  const ouraToken = await getOuraToken(env);
  const samples = await getRingBatteryLevel(ouraToken, startISO, endISO);
  const rows = buildRingBatteryRows(subjectId, samples, ingestedAt);
  if (rows.length === 0) return { start: startISO, end: endISO, count: 0 };

  const token = await getToken(env.GCP_SA_KEY);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const stagingTable = `_staging_oura_ring_battery_${suffix}`;
  try {
    await loadJsonRows({
      projectId: env.GCP_PROJECT,
      datasetId: env.BQ_DATASET,
      tableId: stagingTable,
      rows,
      schema: RING_BATTERY_SCHEMA,
      accessToken: token,
    });
    await runQuery(
      env.GCP_PROJECT,
      ringBatteryMergeSql(env.GCP_PROJECT, env.BQ_DATASET, stagingTable, env.TIMEZONE),
      token,
    );
  } finally {
    await Promise.allSettled([dropTable(env.GCP_PROJECT, env.BQ_DATASET, stagingTable, token)]);
  }
  return { start: startISO, end: endISO, count: rows.length };
}

// Battery-only historical backfill (kind=battery): same 7-day windowing as HR but skips the
// heavy heartrate re-pull — used once to harvest however much battery history the API retains.
async function backfillRingBattery(
  env: Env,
  startDate: string,
  endDate: string,
): Promise<{ chunks: HeartrateResult[]; total: number }> {
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${shiftDays(endDate, 1)}T00:00:00.000Z`;
  const chunks: HeartrateResult[] = [];
  let winStart = startISO;
  while (new Date(winStart).getTime() < new Date(endISO).getTime()) {
    let winEnd = isoShiftDays(winStart, HR_BACKFILL_CHUNK_DAYS);
    if (new Date(winEnd).getTime() > new Date(endISO).getTime()) winEnd = endISO;
    chunks.push(await ingestRingBattery(env, winStart, winEnd));
    winStart = winEnd;
  }
  const total = chunks.reduce((sum, c) => sum + c.count, 0);
  return { chunks, total };
}

// One-time backfill: split [startDate, endDate] (inclusive day range) into <=7-day datetime windows
// and ingest each sequentially. Each window is its own staging table + idempotent MERGE, so a re-run
// (or an overlapping window boundary) never double-counts.
async function backfillHeartrate(
  env: Env,
  startDate: string,
  endDate: string,
): Promise<{ chunks: HeartrateResult[]; total: number; battery_total: number }> {
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${shiftDays(endDate, 1)}T00:00:00.000Z`; // exclusive upper bound = full end day
  const chunks: HeartrateResult[] = [];
  let batteryTotal = 0;
  let winStart = startISO;
  while (new Date(winStart).getTime() < new Date(endISO).getTime()) {
    let winEnd = isoShiftDays(winStart, HR_BACKFILL_CHUNK_DAYS);
    if (new Date(winEnd).getTime() > new Date(endISO).getTime()) winEnd = endISO;
    const [hr, battery] = await Promise.all([
      ingestHeartrate(env, winStart, winEnd),
      ingestRingBattery(env, winStart, winEnd),
    ]);
    chunks.push(hr);
    batteryTotal += battery.count;
    winStart = winEnd;
  }
  const total = chunks.reduce((sum, c) => sum + c.count, 0);
  return { chunks, total, battery_total: batteryTotal };
}

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Shift an ISO datetime by whole days / hours (UTC). Used for HR datetime windowing.
function isoShiftDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
function isoShiftHours(iso: string, hours: number): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === HR_CRON) {
      // Daily intraday-HR incremental: re-pull [now-48h, now], paginate, stage, MERGE.
      ctx.waitUntil(
        (async () => {
          const endISO = new Date().toISOString();
          const startISO = isoShiftHours(endISO, -HR_INCREMENTAL_HOURS);
          const [result, battery] = await Promise.all([
            ingestHeartrate(env, startISO, endISO),
            ingestRingBattery(env, startISO, endISO),
          ]);
          console.log(JSON.stringify({ kind: "scheduled_hr", ...result, battery_count: battery.count }));
        })(),
      );
      return;
    }

    // Default (SUMMARY_CRON): the existing 14-endpoint summary poll with a trailing re-pull window.
    ctx.waitUntil(
      (async () => {
        const today = todayInTz(env.TIMEZONE);
        const end = shiftDays(today, LOOKAHEAD_DAYS);
        const lastSeen = (await env.OURA_STATE.get(KV_KEY_LAST_SEEN)) ?? today;
        const start = shiftDays(lastSeen, -TRAILING_DAYS);
        const result = await ingest(env, start, end);
        await env.OURA_STATE.put(KV_KEY_LAST_SEEN, today);
        console.log(JSON.stringify({ kind: "scheduled", ...result }));
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    // ---- OAuth: start (one-time browser flow; gated by BACKFILL_TOKEN) ----
    if (url.pathname === "/oauth/start") {
      const auth = req.headers.get("authorization") ?? "";
      const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
      if (!env.BACKFILL_TOKEN || token !== env.BACKFILL_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const state = crypto.randomUUID();
      await env.OURA_STATE.put(KV_KEY_OAUTH_STATE_PREFIX + state, "1", { expirationTtl: 600 });
      return Response.redirect(buildAuthorizeUrl(env, state), 302);
    }

    // ---- OAuth: callback (Oura redirects here; CSRF-gated by the state nonce) ----
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      if (err) return new Response(`oura denied: ${err}`, { status: 400 });
      if (!code || !state) return new Response("missing code/state", { status: 400 });
      const seen = await env.OURA_STATE.get(KV_KEY_OAUTH_STATE_PREFIX + state);
      if (!seen) return new Response("unknown/expired state — restart at /oauth/start", { status: 400 });
      await env.OURA_STATE.delete(KV_KEY_OAUTH_STATE_PREFIX + state);
      try {
        const tokens = await exchangeCodeForTokens(env, code);
        await persistTokens(env, tokens);
        return new Response(
          "Oura linked successfully — OAuth grant stored in KV; ingest now prefers it over the PAT. " +
          "Verify the next cron run, then `wrangler secret delete OURA_PAT`.",
          { status: 200 },
        );
      } catch (e) {
        return new Response(`oauth exchange failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    if (url.pathname === "/backfill") {
      const auth = req.headers.get("authorization") ?? "";
      const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
      if (!env.BACKFILL_TOKEN || token !== env.BACKFILL_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? todayInTz(env.TIMEZONE);
      if (!isValidDate(start) || !isValidDate(end)) {
        return new Response("bad start/end (YYYY-MM-DD required)", { status: 400 });
      }
      // kind=hr → intraday heart-rate + battery backfill (chunked); kind=battery → battery only;
      // anything else → the 14-endpoint summary backfill.
      const kind = url.searchParams.get("kind") ?? "summary";
      try {
        if (kind === "hr") {
          const result = await backfillHeartrate(env, start, end);
          return Response.json({ ok: true, kind: "hr", ...result });
        }
        if (kind === "battery") {
          const result = await backfillRingBattery(env, start, end);
          return Response.json({ ok: true, kind: "battery", ...result });
        }
        const result = await ingest(env, start, end);
        return Response.json({ ok: true, kind: "summary", ...result });
      } catch (err) {
        return new Response(`ingest failed: ${(err as Error).message}`, { status: 500 });
      }
    }
    return new Response(
      "cornerstone-oura:\n" +
      "  /healthz\n" +
      "  /oauth/start?token=<BACKFILL_TOKEN>          (one-time browser flow)\n" +
      "  /oauth/callback                              (Oura redirects here)\n" +
      "  /backfill?start=YYYY-MM-DD&end=YYYY-MM-DD[&kind=hr]&token=<BACKFILL_TOKEN>",
      { status: 404, headers: { "content-type": "text/plain" } },
    );
  },
};
