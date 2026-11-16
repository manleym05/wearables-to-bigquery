// Minimal BigQuery client for the action_log table.
//
// Two operations:
//   findLastSuccess(...) — read the last successful action_log row for an idempotency_key
//   writeActionLog(row)  — append a row via streaming insertAll
//
// Both share the same SA access token (`getGcpAccessToken`); the SA needs:
//   roles/bigquery.dataEditor on life_ops (for the insertAll) and dataViewer (for the read).
//   Or equivalently a custom role with bigquery.tables.updateData + jobUser.

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

export interface ActionLogRow {
  ts: string;                              // ISO timestamp
  action_type: string;
  subject_id: number;
  target_date: string | null;              // YYYY-MM-DD
  gate: string | null;
  status: "success" | "skipped" | "error" | "validation_failed";
  external_id: string | null;
  idempotency_key: string | null;
  payload_json: string | null;             // already JSON.stringified
  response_json: string | null;
  payload_hash: string | null;
  http_status: number | null;
  error: string | null;
  worker: string | null;
  raw_request_id: string | null;
}

export async function writeActionLog(
  projectId: string, dataset: string, row: ActionLogRow, accessToken: string,
): Promise<void> {
  // BigQuery streaming insertAll expects JSON-typed columns as **strings** (not nested objects).
  // The row already carries payload_json / response_json as JSON strings; pass them through.
  // (Matches the `raw_json: JSON.stringify(...)` pattern used by workers/maps/src/cache.ts.)
  const url = `${BQ_BASE}/projects/${projectId}/datasets/${dataset}/tables/action_log/insertAll`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ rows: [{ json: row }] }),
  });
  if (!res.ok) throw new Error(`bq insertAll(action_log) HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { insertErrors?: unknown };
  if (out.insertErrors) throw new Error(`bq insertErrors(action_log): ${JSON.stringify(out.insertErrors)}`);
}

export interface PriorSuccess {
  external_id: string;
  ts: string;
}

/** Find the most recent successful row for this idempotency key (Hevy returns the routine_id
 *  in external_id). Used to decide POST vs PUT. */
export async function findLastSuccess(
  projectId: string, dataset: string, subjectId: number, actionType: string,
  idempotencyKey: string, accessToken: string,
): Promise<PriorSuccess | null> {
  const sql = `
SELECT external_id, CAST(ts AS STRING) AS ts
FROM \`${projectId}.${dataset}.action_log\`
WHERE subject_id = @sid
  AND action_type = @at
  AND idempotency_key = @key
  AND status = 'success'
ORDER BY ts DESC
LIMIT 1`.trim();
  const res = await fetch(`${BQ_BASE}/projects/${projectId}/queries`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
      parameterMode: "NAMED",
      queryParameters: [
        { name: "sid", parameterType: { type: "INT64" },  parameterValue: { value: String(subjectId) } },
        { name: "at",  parameterType: { type: "STRING" }, parameterValue: { value: actionType } },
        { name: "key", parameterType: { type: "STRING" }, parameterValue: { value: idempotencyKey } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`bq query(action_log) HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as {
    rows?: Array<{ f: Array<{ v: string | null }> }>;
    schema?: { fields: Array<{ name: string }> };
  };
  if (!out.rows || out.rows.length === 0) return null;
  const fields = out.schema?.fields.map((f) => f.name) ?? [];
  const cells: Record<string, string | null> = {};
  out.rows[0].f.forEach((cell, i) => { cells[fields[i] ?? `f${i}`] = cell.v; });
  if (!cells.external_id) return null;
  return { external_id: cells.external_id, ts: cells.ts ?? "" };
}

export interface LastWeight { lb: number; reps: string }

/** Per-exercise last-logged top working weight (lb) + per-set reps, keyed by Hevy
 *  exercise_template_id. For EACH exercise the subject has ever logged, returns the top set
 *  weight + reps from the most recent day (< beforeDate) that exercise was performed — across
 *  ALL sessions, independent of workout title. Powers the progressive-overload default weight +
 *  the "last" note. (Until 2026-07-19 this matched only the last same-type-*titled* session, but
 *  Hevy workout titles aren't the gameplan day names, so Lower days seeded almost nothing — the
 *  per-exercise lookup fixes that.) Best-effort: returns an empty map on any error so the push
 *  never depends on it. raw_json is a stringified Hevy workout (JSON column holding a string),
 *  so it needs PARSE_JSON(JSON_VALUE(...)). */
export async function getLastSessionWeights(
  projectId: string, dataset: string, subjectId: number, beforeDate: string, accessToken: string,
): Promise<Map<string, LastWeight>> {
  const out = new Map<string, LastWeight>();
  const sql = `
WITH ex_sets AS (
  SELECT
    JSON_VALUE(ex, '$.exercise_template_id') AS template_id,
    w.day AS day,
    SAFE_CAST(JSON_VALUE(s, '$.weight_kg') AS FLOAT64) AS weight_kg,
    SAFE_CAST(JSON_VALUE(s, '$.reps') AS INT64) AS reps,
    SAFE_CAST(JSON_VALUE(s, '$.index') AS INT64) AS set_index
  FROM \`${projectId}.${dataset}.raw_hevy_workout\` w,
    UNNEST(JSON_EXTRACT_ARRAY(PARSE_JSON(JSON_VALUE(w.raw_json)), '$.exercises')) AS ex,
    UNNEST(JSON_EXTRACT_ARRAY(ex, '$.sets')) AS s
  WHERE w.subject_id = @sid AND w.day < @date
),
latest AS (
  SELECT template_id, MAX(day) AS last_day
  FROM ex_sets WHERE template_id IS NOT NULL
  GROUP BY template_id
)
SELECT
  e.template_id AS template_id,
  ROUND(MAX(e.weight_kg) * 2.20462, 0) AS top_lb,
  STRING_AGG(CAST(e.reps AS STRING), '/' ORDER BY e.set_index) AS reps_by_set
FROM ex_sets e JOIN latest l ON e.template_id = l.template_id AND e.day = l.last_day
GROUP BY e.template_id`.trim();
  try {
    const res = await fetch(`${BQ_BASE}/projects/${projectId}/queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: sql, useLegacySql: false, timeoutMs: 30000, parameterMode: "NAMED",
        queryParameters: [
          { name: "sid",  parameterType: { type: "INT64" }, parameterValue: { value: String(subjectId) } },
          { name: "date", parameterType: { type: "DATE" },  parameterValue: { value: beforeDate } },
        ],
      }),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { rows?: Array<{ f: Array<{ v: string | null }> }>; schema?: { fields: Array<{ name: string }> } };
    if (!data.rows) return out;
    const fields = data.schema?.fields.map((f) => f.name) ?? [];
    for (const row of data.rows) {
      const cells: Record<string, string | null> = {};
      row.f.forEach((c, i) => { cells[fields[i] ?? `f${i}`] = c.v; });
      const tid = cells.template_id;
      const lb = cells.top_lb != null ? Number(cells.top_lb) : NaN;
      if (tid && Number.isFinite(lb) && lb > 0) out.set(tid, { lb, reps: cells.reps_by_set ?? "" });
    }
  } catch { /* best-effort — no weights on error */ }
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
