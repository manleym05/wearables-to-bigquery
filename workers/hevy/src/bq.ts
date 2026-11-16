// BigQuery REST client + Hevy staging schemas. Helpers identical across workers.

import { getGcpAccessToken } from "./jwt";

type TableSchemaField = {
  name: string;
  type: "STRING" | "INT64" | "FLOAT64" | "BOOL" | "DATE" | "TIMESTAMP" | "JSON";
  mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
};

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_UPLOAD = "https://bigquery.googleapis.com/upload/bigquery/v2";

export async function getToken(saKey: string): Promise<string> { return getGcpAccessToken(saKey); }

export interface LoadJobArgs {
  projectId: string; datasetId: string; tableId: string;
  rows: object[]; schema: TableSchemaField[]; accessToken: string;
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
  const res = await fetch(`${BQ_UPLOAD}/projects/${projectId}/jobs?uploadType=multipart`, {
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
    jobComplete: boolean; jobReference?: { jobId: string; location?: string }; errors?: unknown;
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

// ---------- Hevy staging schemas ----------

export const WORKOUT_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "workout_id", type: "STRING", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "title", type: "STRING" },
  { name: "description", type: "STRING" },
  { name: "start_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "end_at", type: "TIMESTAMP" },
  { name: "duration_min", type: "INT64" },
  { name: "exercise_count", type: "INT64" },
  { name: "set_count", type: "INT64" },
  { name: "total_volume_kg", type: "FLOAT64" },
  { name: "total_volume_lb", type: "FLOAT64" },
  { name: "total_reps", type: "INT64" },
  { name: "avg_rpe", type: "FLOAT64" },
  { name: "created_at", type: "TIMESTAMP" },
  { name: "updated_at", type: "TIMESTAMP" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const SET_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "workout_id", type: "STRING", mode: "REQUIRED" },
  { name: "exercise_idx", type: "INT64", mode: "REQUIRED" },
  { name: "set_idx", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "exercise_template_id", type: "STRING", mode: "REQUIRED" },
  { name: "exercise_title", type: "STRING" },
  { name: "exercise_notes", type: "STRING" },
  { name: "supersets_id", type: "INT64" },
  { name: "set_type", type: "STRING" },
  { name: "weight_kg", type: "FLOAT64" },
  { name: "weight_lb", type: "FLOAT64" },
  { name: "reps", type: "INT64" },
  { name: "distance_m", type: "FLOAT64" },
  { name: "duration_s", type: "INT64" },
  { name: "rpe", type: "FLOAT64" },
  { name: "custom_metric", type: "FLOAT64" },
  { name: "volume_kg", type: "FLOAT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const EXERCISE_TEMPLATE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "exercise_template_id", type: "STRING", mode: "REQUIRED" },
  { name: "title", type: "STRING" },
  { name: "type", type: "STRING" },
  { name: "primary_muscle_group", type: "STRING" },
  { name: "secondary_muscle_groups_json", type: "JSON" },
  { name: "equipment", type: "STRING" },
  { name: "is_custom", type: "BOOL" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];
