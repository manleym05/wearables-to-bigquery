import type { Env } from "./env";
import {
  getToken, loadJsonRows, runQuery, dropTable,
  MEASURE_SCHEMA, SLEEP_SCHEMA, ACTIVITY_SCHEMA, WORKOUT_SCHEMA, HEART_SCHEMA, DEVICE_SCHEMA,
} from "./bq";
import {
  buildAuthorizeUrl, exchangeCodeForTokens, persistTokens, getWithingsAccessToken,
} from "./oauth";
import {
  getMeasures, getSleepSummaries, getActivities, getWorkouts, getHeartList, getDevices,
} from "./withings";
import {
  buildMeasureRows, buildSleepRows, buildActivityRows, buildWorkoutRows, buildHeartRows, buildDeviceRows,
} from "./shape";
import {
  measureMergeSql, sleepMergeSql, activityMergeSql, workoutMergeSql, heartMergeSql, deviceMergeSql,
} from "./merge";

const TRAILING_DAYS = 3;
const KV_KEY_LAST_SEEN = "last_seen";
const KV_KEY_OAUTH_STATE_PREFIX = "oauth_state:";

interface IngestResult {
  start: string;
  end: string;
  counts: Record<string, number>;
}

interface TableSpec {
  short: string;
  table: string;
  schema: typeof MEASURE_SCHEMA;
  rows: object[];
  mergeSql: (project: string, dataset: string, stagingTable: string) => string;
}

async function ingest(env: Env, start: string, end: string): Promise<IngestResult> {
  const subjectId = Number(env.SUBJECT_ID);
  const tz = env.TIMEZONE;
  const ingestedAt = new Date().toISOString();

  const withingsToken = await getWithingsAccessToken(env);

  const [measures, sleeps, activities, workouts, hearts, devices] = await Promise.all([
    getMeasures(withingsToken, start, end),
    getSleepSummaries(withingsToken, start, end),
    getActivities(withingsToken, start, end),
    getWorkouts(withingsToken, start, end),
    getHeartList(withingsToken, start, end),
    getDevices(withingsToken),
  ]);

  const specs: TableSpec[] = [
    { short: "measure",  table: "raw_withings_measure",  schema: MEASURE_SCHEMA,  rows: buildMeasureRows(subjectId, measures, tz, ingestedAt),  mergeSql: measureMergeSql },
    { short: "sleep",    table: "raw_withings_sleep",    schema: SLEEP_SCHEMA,    rows: buildSleepRows(subjectId, sleeps, ingestedAt),          mergeSql: sleepMergeSql },
    { short: "activity", table: "raw_withings_activity", schema: ACTIVITY_SCHEMA, rows: buildActivityRows(subjectId, activities, ingestedAt),   mergeSql: activityMergeSql },
    { short: "workout",  table: "raw_withings_workout",  schema: WORKOUT_SCHEMA,  rows: buildWorkoutRows(subjectId, workouts, ingestedAt),      mergeSql: workoutMergeSql },
    { short: "heart",    table: "raw_withings_heart",    schema: HEART_SCHEMA,    rows: buildHeartRows(subjectId, hearts, tz, ingestedAt),      mergeSql: heartMergeSql },
    { short: "device",   table: "raw_withings_device",   schema: DEVICE_SCHEMA,   rows: buildDeviceRows(subjectId, devices, ingestedAt),        mergeSql: deviceMergeSql },
  ];

  const gcpToken = await getToken(env.GCP_SA_KEY);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const counts: Record<string, number> = {};
  const stagingTables: { table: string }[] = [];

  try {
    await Promise.all(
      specs.map(async (spec) => {
        counts[spec.short] = spec.rows.length;
        if (spec.rows.length === 0) return;
        const stagingTable = `_staging_${spec.table.replace(/^raw_withings_/, "withings_")}_${suffix}`;
        stagingTables.push({ table: stagingTable });
        await loadJsonRows({
          projectId: env.GCP_PROJECT,
          datasetId: env.BQ_DATASET,
          tableId: stagingTable,
          rows: spec.rows,
          schema: spec.schema,
          accessToken: gcpToken,
        });
        await runQuery(
          env.GCP_PROJECT,
          spec.mergeSql(env.GCP_PROJECT, env.BQ_DATASET, stagingTable),
          gcpToken,
        );
      }),
    );
  } finally {
    await Promise.allSettled(
      stagingTables.map((s) => dropTable(env.GCP_PROJECT, env.BQ_DATASET, s.table, gcpToken)),
    );
  }

  return { start, end, counts };
}

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

function requireAdmin(env: Env, url: URL, req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const today = todayInTz(env.TIMEZONE);
        const lastSeen = (await env.WITHINGS_STATE.get(KV_KEY_LAST_SEEN)) ?? today;
        const start = shiftDays(lastSeen, -TRAILING_DAYS);
        const result = await ingest(env, start, today);
        await env.WITHINGS_STATE.put(KV_KEY_LAST_SEEN, today);
        console.log(JSON.stringify({ kind: "scheduled", ...result }));
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return new Response("ok");

    // ---- OAuth: start ----
    if (url.pathname === "/oauth/start") {
      const denied = requireAdmin(env, url, req);
      if (denied) return denied;
      const state = crypto.randomUUID();
      await env.WITHINGS_STATE.put(KV_KEY_OAUTH_STATE_PREFIX + state, "1", { expirationTtl: 600 });
      return Response.redirect(buildAuthorizeUrl(env, state), 302);
    }

    // ---- OAuth: callback ----
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      if (err) return new Response(`withings denied: ${err}`, { status: 400 });
      if (!code || !state) return new Response("missing code/state", { status: 400 });
      const seen = await env.WITHINGS_STATE.get(KV_KEY_OAUTH_STATE_PREFIX + state);
      if (!seen) return new Response("invalid/expired state", { status: 400 });
      await env.WITHINGS_STATE.delete(KV_KEY_OAUTH_STATE_PREFIX + state);
      try {
        const tokens = await exchangeCodeForTokens(env, code);
        await persistTokens(env, tokens);
        return new Response(
          `Withings linked successfully. userid=${tokens.userid}. Refresh token stored in KV. ` +
          `Next: hit /backfill?start=2024-01-01&end=${todayInTz(env.TIMEZONE)}&token=<ADMIN_TOKEN>`,
          { status: 200 },
        );
      } catch (e) {
        return new Response(`oauth exchange failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    // ---- backfill ----
    if (url.pathname === "/backfill") {
      const denied = requireAdmin(env, url, req);
      if (denied) return denied;
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? todayInTz(env.TIMEZONE);
      if (!isValidDate(start) || !isValidDate(end)) {
        return new Response("bad start/end (YYYY-MM-DD required)", { status: 400 });
      }
      try {
        const result = await ingest(env, start, end);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return new Response(`ingest failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    return new Response(
      "cornerstone-withings:\n" +
      "  /healthz\n" +
      "  /oauth/start?token=<ADMIN_TOKEN>            (one-time browser flow)\n" +
      "  /oauth/callback                              (Withings redirects here)\n" +
      "  /backfill?start=YYYY-MM-DD&end=YYYY-MM-DD&token=<ADMIN_TOKEN>",
      { status: 404, headers: { "content-type": "text/plain" } },
    );
  },
};
