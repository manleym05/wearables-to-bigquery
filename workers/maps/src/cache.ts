// BQ-backed cache for Directions results.
// Lookup: SELECT WHERE cache_key = X AND cached_until > NOW().
// Write:  INSERT (single row, no MERGE — duplicates don't matter for cache hits;
//         lookup picks the latest valid row).

import type { DirectionsLegSummary, Mode, DayType } from "./maps";

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

export interface CachedRow {
  cache_key: string;
  duration_s: number | null;
  duration_in_traffic_s: number | null;
  distance_m: number | null;
  route_summary: string | null;
  duration_text: string | null;
  distance_text: string | null;
  cached_until: string;
  requested_at: string;
  raw_json: unknown;
}

export async function readCache(
  projectId: string, dataset: string, cacheKey: string, accessToken: string,
): Promise<CachedRow | null> {
  const sql = `
SELECT
  cache_key, duration_s, duration_in_traffic_s, distance_m,
  route_summary, duration_text, distance_text,
  CAST(cached_until AS STRING) AS cached_until,
  CAST(requested_at AS STRING) AS requested_at,
  raw_json
FROM \`${projectId}.${dataset}.raw_maps_directions\`
WHERE cache_key = @key
  AND cached_until > CURRENT_TIMESTAMP()
ORDER BY requested_at DESC
LIMIT 1`.trim();

  const res = await fetch(`${BQ_BASE}/projects/${projectId}/queries`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
      queryParameters: [{ name: "key", parameterType: { type: "STRING" }, parameterValue: { value: cacheKey } }],
      parameterMode: "NAMED",
    }),
  });
  if (!res.ok) throw new Error(`bq cache read ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as {
    jobComplete?: boolean;
    rows?: Array<{ f: Array<{ v: string | null }> }>;
    schema?: { fields: Array<{ name: string }> };
  };
  if (!out.rows || out.rows.length === 0) return null;
  const fields = out.schema?.fields.map((f) => f.name) ?? [];
  const row: Record<string, string | null> = {};
  out.rows[0].f.forEach((cell, i) => {
    row[fields[i] ?? `f${i}`] = cell.v;
  });
  return {
    cache_key: row.cache_key ?? "",
    duration_s: row.duration_s == null ? null : Number(row.duration_s),
    duration_in_traffic_s: row.duration_in_traffic_s == null ? null : Number(row.duration_in_traffic_s),
    distance_m: row.distance_m == null ? null : Number(row.distance_m),
    route_summary: row.route_summary,
    duration_text: row.duration_text,
    distance_text: row.distance_text,
    cached_until: row.cached_until ?? "",
    requested_at: row.requested_at ?? "",
    raw_json: row.raw_json ? JSON.parse(row.raw_json) : null,
  };
}

export interface WriteCacheArgs {
  projectId: string;
  dataset: string;
  accessToken: string;
  subjectId: number;
  cacheKey: string;
  origin: string;
  destination: string;
  mode: Mode;
  departureHour: number;
  dayType: DayType;
  result: DirectionsLegSummary;
  ttlDays: number;
}

export async function writeCache(args: WriteCacheArgs): Promise<void> {
  const now = new Date();
  const cachedUntil = new Date(now.getTime() + args.ttlDays * 86_400_000);
  const row = {
    subject_id: args.subjectId,
    cache_key: args.cacheKey,
    origin: args.origin,
    destination: args.destination,
    mode: args.mode,
    departure_hour: args.departureHour,
    day_type: args.dayType,
    departure_time_used: args.result.departure_time_used,
    duration_s: args.result.duration_s,
    duration_text: args.result.duration_text,
    duration_in_traffic_s: args.result.duration_in_traffic_s,
    duration_in_traffic_text: args.result.duration_in_traffic_text,
    distance_m: args.result.distance_m,
    distance_text: args.result.distance_text,
    start_address: args.result.start_address,
    end_address: args.result.end_address,
    start_lat: args.result.start_lat,
    start_lng: args.result.start_lng,
    end_lat: args.result.end_lat,
    end_lng: args.result.end_lng,
    route_summary: args.result.route_summary,
    polyline: args.result.polyline,
    warnings_json: args.result.warnings.length > 0 ? JSON.stringify(args.result.warnings) : null,
    copyrights: args.result.copyrights,
    source: "google_maps",
    raw_json: JSON.stringify(args.result.raw),
    requested_at: now.toISOString(),
    cached_until: cachedUntil.toISOString(),
  };
  const res = await fetch(
    `${BQ_BASE}/projects/${args.projectId}/datasets/${args.dataset}/tables/raw_maps_directions/insertAll`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${args.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ json: row }] }),
    },
  );
  if (!res.ok) throw new Error(`bq insertAll ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { insertErrors?: unknown };
  if (out.insertErrors) throw new Error(`bq insertErrors: ${JSON.stringify(out.insertErrors)}`);
}
