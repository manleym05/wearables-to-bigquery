// BigQuery REST client + Strava staging schemas.
// Helpers identical to workers/oura + workers/withings.

import { getGcpAccessToken } from "./jwt";

type TableSchemaField = {
  name: string;
  type: "STRING" | "INT64" | "FLOAT64" | "BOOL" | "DATE" | "TIMESTAMP" | "JSON";
  mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
};

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_UPLOAD = "https://bigquery.googleapis.com/upload/bigquery/v2";

export async function getToken(saKey: string): Promise<string> {
  return getGcpAccessToken(saKey);
}

export interface LoadJobArgs {
  projectId: string;
  datasetId: string;
  tableId: string;
  rows: object[];
  schema: TableSchemaField[];
  accessToken: string;
}

export async function loadJsonRows(args: LoadJobArgs): Promise<void> {
  const { projectId, datasetId, tableId, rows, schema, accessToken } = args;
  if (rows.length === 0) return;

  const jobConfig = {
    configuration: {
      load: {
        destinationTable: { projectId, datasetId, tableId },
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        writeDisposition: "WRITE_TRUNCATE",
        createDisposition: "CREATE_IF_NEEDED",
        schema: { fields: schema },
        ignoreUnknownValues: false,
      },
    },
  };
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const boundary = "----cornerstone-" + crypto.randomUUID();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(jobConfig) +
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n` +
    ndjson +
    `\r\n--${boundary}--\r\n`;
  const url = `${BQ_UPLOAD}/projects/${projectId}/jobs?uploadType=multipart`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`bq load job submit ${res.status}: ${await res.text()}`);
  const job = (await res.json()) as { jobReference: { jobId: string; location?: string } };
  await waitForJob(projectId, job.jobReference.jobId, job.jobReference.location, accessToken);
}

export async function runQuery(projectId: string, sql: string, accessToken: string): Promise<void> {
  const url = `${BQ_BASE}/projects/${projectId}/queries`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
  });
  if (!res.ok) throw new Error(`bq query ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as {
    jobComplete: boolean;
    jobReference?: { jobId: string; location?: string };
    errors?: unknown;
  };
  if (out.errors) throw new Error(`bq query errors: ${JSON.stringify(out.errors)}`);
  if (out.jobComplete) return;
  if (!out.jobReference) throw new Error("bq query: no jobReference");
  await waitForJob(projectId, out.jobReference.jobId, out.jobReference.location, accessToken);
}

export async function dropTable(projectId: string, datasetId: string, tableId: string, accessToken: string): Promise<void> {
  const url = `${BQ_BASE}/projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
  const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 404) throw new Error(`bq drop ${res.status}: ${await res.text()}`);
}

async function waitForJob(projectId: string, jobId: string, location: string | undefined, accessToken: string): Promise<void> {
  const locQs = location ? `?location=${encodeURIComponent(location)}` : "";
  const url = `${BQ_BASE}/projects/${projectId}/jobs/${jobId}${locQs}`;
  const deadline = Date.now() + 60_000;
  let delay = 500;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`bq job poll ${res.status}: ${await res.text()}`);
    const job = (await res.json()) as { status: { state: string; errorResult?: { message: string } } };
    if (job.status.state === "DONE") {
      if (job.status.errorResult) throw new Error(`bq job failed: ${job.status.errorResult.message}`);
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  throw new Error(`bq job ${jobId} did not complete within 60s`);
}

// ---------- staging schemas ----------

export const ACTIVITY_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "activity_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "external_id", type: "STRING" },
  { name: "upload_id", type: "INT64" },
  { name: "name", type: "STRING" },
  { name: "type", type: "STRING" },
  { name: "sport_type", type: "STRING" },
  { name: "workout_type", type: "INT64" },
  { name: "start_at", type: "TIMESTAMP" },
  { name: "start_at_local", type: "TIMESTAMP" },
  { name: "timezone", type: "STRING" },
  { name: "utc_offset_s", type: "INT64" },
  { name: "distance_m", type: "FLOAT64" },
  { name: "moving_time_s", type: "INT64" },
  { name: "elapsed_time_s", type: "INT64" },
  { name: "elevation_gain_m", type: "FLOAT64" },
  { name: "elev_high_m", type: "FLOAT64" },
  { name: "elev_low_m", type: "FLOAT64" },
  { name: "avg_speed_m_s", type: "FLOAT64" },
  { name: "max_speed_m_s", type: "FLOAT64" },
  { name: "avg_cadence", type: "FLOAT64" },
  { name: "avg_temp_c", type: "FLOAT64" },
  { name: "avg_hr_bpm", type: "FLOAT64" },
  { name: "max_hr_bpm", type: "FLOAT64" },
  { name: "has_heartrate", type: "BOOL" },
  { name: "avg_watts", type: "FLOAT64" },
  { name: "max_watts", type: "FLOAT64" },
  { name: "weighted_avg_watts", type: "FLOAT64" },
  { name: "device_watts", type: "BOOL" },
  { name: "kilojoules", type: "FLOAT64" },
  { name: "suffer_score", type: "FLOAT64" },
  { name: "calories", type: "FLOAT64" },
  { name: "start_lat", type: "FLOAT64" },
  { name: "start_lng", type: "FLOAT64" },
  { name: "end_lat", type: "FLOAT64" },
  { name: "end_lng", type: "FLOAT64" },
  { name: "gear_id", type: "STRING" },
  { name: "device_name", type: "STRING" },
  { name: "is_trainer", type: "BOOL" },
  { name: "is_commute", type: "BOOL" },
  { name: "is_manual", type: "BOOL" },
  { name: "is_private", type: "BOOL" },
  { name: "visibility", type: "STRING" },
  { name: "pr_count", type: "INT64" },
  { name: "achievement_count", type: "INT64" },
  { name: "kudos_count", type: "INT64" },
  { name: "comment_count", type: "INT64" },
  { name: "athlete_count", type: "INT64" },
  { name: "photo_count", type: "INT64" },
  { name: "location_city", type: "STRING" },
  { name: "location_state", type: "STRING" },
  { name: "location_country", type: "STRING" },
  { name: "summary_polyline", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const ATHLETE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "athlete_id", type: "INT64", mode: "REQUIRED" },
  { name: "username", type: "STRING" },
  { name: "firstname", type: "STRING" },
  { name: "lastname", type: "STRING" },
  { name: "city", type: "STRING" },
  { name: "state", type: "STRING" },
  { name: "country", type: "STRING" },
  { name: "sex", type: "STRING" },
  { name: "premium", type: "BOOL" },
  { name: "summit", type: "BOOL" },
  { name: "weight_kg", type: "FLOAT64" },
  { name: "ftp_watts", type: "FLOAT64" },
  { name: "measurement_preference", type: "STRING" },
  { name: "created_at", type: "TIMESTAMP" },
  { name: "updated_at", type: "TIMESTAMP" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const ZONES_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "hr_zones_json", type: "JSON" },
  { name: "power_zones_json", type: "JSON" },
  { name: "hr_zones_custom", type: "BOOL" },
  { name: "power_zones_custom", type: "BOOL" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];
