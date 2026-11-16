import type { Env } from "./env";
import {
  getToken, loadJsonRows, runQuery, dropTable,
  WORKOUT_SCHEMA, SET_SCHEMA, EXERCISE_TEMPLATE_SCHEMA,
} from "./bq";
import { getWorkoutsInRange, getAllExerciseTemplates } from "./hevy";
import { buildWorkoutRows, buildSetRows, buildExerciseTemplateRows } from "./shape";
import { workoutMergeSql, setMergeSql, exerciseTemplateMergeSql } from "./merge";

const TRAILING_DAYS = 7;   // Hevy workouts can be retroactively edited; 7 days catches stragglers.
const KV_KEY_LAST_SEEN = "last_seen";

interface IngestResult { start: string; end: string; counts: Record<string, number> }

interface TableSpec {
  short: string;
  table: string;
  schema: typeof WORKOUT_SCHEMA;
  rows: object[];
  mergeSql: (project: string, dataset: string, stagingTable: string) => string;
}

async function ingest(env: Env, start: string, end: string): Promise<IngestResult> {
  const subjectId = Number(env.SUBJECT_ID);
  const tz = env.TIMEZONE;
  const ingestedAt = new Date().toISOString();

  const [workouts, templates] = await Promise.all([
    getWorkoutsInRange(env.HEVY_API_KEY, start, end),
    getAllExerciseTemplates(env.HEVY_API_KEY),
  ]);

  const specs: TableSpec[] = [
    { short: "workout",  table: "raw_hevy_workout",            schema: WORKOUT_SCHEMA,           rows: buildWorkoutRows(subjectId, workouts, tz, ingestedAt),           mergeSql: workoutMergeSql },
    { short: "set",      table: "raw_hevy_set",                schema: SET_SCHEMA,               rows: buildSetRows(subjectId, workouts, tz, ingestedAt),               mergeSql: setMergeSql },
    { short: "template", table: "raw_hevy_exercise_template",  schema: EXERCISE_TEMPLATE_SCHEMA, rows: buildExerciseTemplateRows(subjectId, templates, ingestedAt),     mergeSql: exerciseTemplateMergeSql },
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
        const stagingTable = `_staging_${spec.table.replace(/^raw_hevy_/, "hevy_")}_${suffix}`;
        stagingTables.push({ table: stagingTable });
        await loadJsonRows({
          projectId: env.GCP_PROJECT, datasetId: env.BQ_DATASET, tableId: stagingTable,
          rows: spec.rows, schema: spec.schema, accessToken: gcpToken,
        });
        await runQuery(env.GCP_PROJECT, spec.mergeSql(env.GCP_PROJECT, env.BQ_DATASET, stagingTable), gcpToken);
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
        const lastSeen = (await env.HEVY_STATE.get(KV_KEY_LAST_SEEN)) ?? today;
        const start = shiftDays(lastSeen, -TRAILING_DAYS);
        const result = await ingest(env, start, today);
        await env.HEVY_STATE.put(KV_KEY_LAST_SEEN, today);
        console.log(JSON.stringify({ kind: "scheduled", ...result }));
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
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
      "cornerstone-hevy:\n" +
      "  /healthz\n" +
      "  /backfill?start=YYYY-MM-DD&end=YYYY-MM-DD&token=<ADMIN_TOKEN>",
      { status: 404, headers: { "content-type": "text/plain" } },
    );
  },
};
