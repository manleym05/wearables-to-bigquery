// Minimal BigQuery REST client for Workers.
// Mirrors workers/oura/src/bq.ts; Withings-specific staging schemas at the bottom.

import { getGcpAccessToken } from "./jwt";

type TableSchemaField =
  | { name: string; type: "STRING" | "INT64" | "FLOAT64" | "BOOL" | "DATE" | "TIMESTAMP" | "JSON"; mode?: "NULLABLE" | "REQUIRED" | "REPEATED" };

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
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(jobConfig) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    ndjson +
    `\r\n--${boundary}--\r\n`;

  const uploadUrl = `${BQ_UPLOAD}/projects/${projectId}/jobs?uploadType=multipart`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
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
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
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
  if (!out.jobReference) throw new Error("bq query: no jobReference returned");
  await waitForJob(projectId, out.jobReference.jobId, out.jobReference.location, accessToken);
}

export async function dropTable(projectId: string, datasetId: string, tableId: string, accessToken: string): Promise<void> {
  const url = `${BQ_BASE}/projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`bq drop table ${res.status}: ${await res.text()}`);
  }
}

async function waitForJob(projectId: string, jobId: string, location: string | undefined, accessToken: string): Promise<void> {
  const locQs = location ? `?location=${encodeURIComponent(location)}` : "";
  const url = `${BQ_BASE}/projects/${projectId}/jobs/${jobId}${locQs}`;
  const deadline = Date.now() + 60_000;
  let delay = 500;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`bq job poll ${res.status}: ${await res.text()}`);
    const job = (await res.json()) as {
      status: { state: string; errorResult?: { message: string }; errors?: unknown };
    };
    if (job.status.state === "DONE") {
      if (job.status.errorResult) throw new Error(`bq job failed: ${job.status.errorResult.message}`);
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  throw new Error(`bq job ${jobId} did not complete within 60s`);
}

// ---------- Withings staging schemas ----------

export const MEASURE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "grpid", type: "INT64", mode: "REQUIRED" },
  { name: "measured_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "weight_kg", type: "FLOAT64" },
  { name: "height_m", type: "FLOAT64" },
  { name: "fat_free_mass_kg", type: "FLOAT64" },
  { name: "fat_ratio_pct", type: "FLOAT64" },
  { name: "fat_mass_kg", type: "FLOAT64" },
  { name: "muscle_mass_kg", type: "FLOAT64" },
  { name: "hydration_kg", type: "FLOAT64" },
  { name: "bone_mass_kg", type: "FLOAT64" },
  { name: "bp_diastolic_mmhg", type: "FLOAT64" },
  { name: "bp_systolic_mmhg", type: "FLOAT64" },
  { name: "heart_pulse_bpm", type: "FLOAT64" },
  { name: "spo2_pct", type: "FLOAT64" },
  { name: "body_temp_c", type: "FLOAT64" },
  { name: "skin_temp_c", type: "FLOAT64" },
  { name: "pulse_wave_velocity_m_s", type: "FLOAT64" },
  { name: "vo2_max", type: "FLOAT64" },
  { name: "vascular_age_years", type: "FLOAT64" },
  { name: "afib_result", type: "INT64" },
  { name: "nerve_health", type: "FLOAT64" },
  { name: "attrib", type: "INT64" },
  { name: "category", type: "INT64" },
  { name: "device_id", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const SLEEP_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "sleep_id", type: "STRING", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "startdate", type: "TIMESTAMP" },
  { name: "enddate", type: "TIMESTAMP" },
  { name: "total_sleep_h", type: "FLOAT64" },
  { name: "asleep_h", type: "FLOAT64" },
  { name: "deep_sleep_h", type: "FLOAT64" },
  { name: "light_sleep_h", type: "FLOAT64" },
  { name: "rem_sleep_h", type: "FLOAT64" },
  { name: "awake_h", type: "FLOAT64" },
  { name: "time_in_bed_h", type: "FLOAT64" },
  { name: "sleep_efficiency_pct", type: "FLOAT64" },
  { name: "sleep_score", type: "INT64" },
  { name: "withings_index", type: "FLOAT64" },
  { name: "sleep_latency_min", type: "FLOAT64" },
  { name: "wakeup_latency_min", type: "FLOAT64" },
  { name: "wakeup_count", type: "INT64" },
  { name: "waso_min", type: "FLOAT64" },
  { name: "nb_rem_episodes", type: "INT64" },
  { name: "out_of_bed_count", type: "INT64" },
  { name: "hr_avg_bpm", type: "FLOAT64" },
  { name: "hr_min_bpm", type: "FLOAT64" },
  { name: "hr_max_bpm", type: "FLOAT64" },
  { name: "hrv_avg_ms", type: "FLOAT64" },
  { name: "hrv_lowest_ms", type: "FLOAT64" },
  { name: "rr_avg", type: "FLOAT64" },
  { name: "rr_min", type: "FLOAT64" },
  { name: "rr_max", type: "FLOAT64" },
  { name: "breathing_disturbances_intensity", type: "FLOAT64" },
  { name: "snoring_episode_count", type: "INT64" },
  { name: "snoring_s", type: "INT64" },
  { name: "apnea_hypopnea_index", type: "FLOAT64" },
  { name: "timezone", type: "STRING" },
  { name: "model", type: "STRING" },
  { name: "model_id", type: "INT64" },
  { name: "device_id_hash", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const ACTIVITY_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "timezone", type: "STRING" },
  { name: "device_id_hash", type: "STRING" },
  { name: "is_tracker", type: "BOOL" },
  { name: "steps", type: "INT64" },
  { name: "distance_m", type: "FLOAT64" },
  { name: "elevation_m", type: "FLOAT64" },
  { name: "soft_s", type: "INT64" },
  { name: "moderate_s", type: "INT64" },
  { name: "intense_s", type: "INT64" },
  { name: "active_s", type: "INT64" },
  { name: "calories", type: "FLOAT64" },
  { name: "total_calories", type: "FLOAT64" },
  { name: "hr_avg_bpm", type: "FLOAT64" },
  { name: "hr_min_bpm", type: "FLOAT64" },
  { name: "hr_max_bpm", type: "FLOAT64" },
  { name: "hr_zone_0_s", type: "INT64" },
  { name: "hr_zone_1_s", type: "INT64" },
  { name: "hr_zone_2_s", type: "INT64" },
  { name: "hr_zone_3_s", type: "INT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const WORKOUT_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "workout_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "category", type: "INT64" },
  { name: "attrib", type: "INT64" },
  { name: "startdate", type: "TIMESTAMP" },
  { name: "enddate", type: "TIMESTAMP" },
  { name: "effective_duration_s", type: "INT64" },
  { name: "pause_duration_s", type: "INT64" },
  { name: "algo_pause_duration_s", type: "INT64" },
  { name: "intensity", type: "INT64" },
  { name: "calories", type: "FLOAT64" },
  { name: "manual_calories", type: "FLOAT64" },
  { name: "steps", type: "INT64" },
  { name: "distance_m", type: "FLOAT64" },
  { name: "manual_distance_m", type: "FLOAT64" },
  { name: "elevation_m", type: "FLOAT64" },
  { name: "ascent_m", type: "FLOAT64" },
  { name: "descent_m", type: "FLOAT64" },
  { name: "spo2_avg_pct", type: "FLOAT64" },
  { name: "hr_avg_bpm", type: "FLOAT64" },
  { name: "hr_min_bpm", type: "FLOAT64" },
  { name: "hr_max_bpm", type: "FLOAT64" },
  { name: "hr_zone_0_s", type: "INT64" },
  { name: "hr_zone_1_s", type: "INT64" },
  { name: "hr_zone_2_s", type: "INT64" },
  { name: "hr_zone_3_s", type: "INT64" },
  { name: "device_id", type: "STRING" },
  { name: "model", type: "INT64" },
  { name: "model_id", type: "INT64" },
  { name: "timezone", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const HEART_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "measurement_id", type: "STRING", mode: "REQUIRED" },
  { name: "measured_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "heart_rate_bpm", type: "FLOAT64" },
  { name: "ecg_signal_id", type: "INT64" },
  { name: "afib_classification", type: "INT64" },
  { name: "bp_systolic_mmhg", type: "FLOAT64" },
  { name: "bp_diastolic_mmhg", type: "FLOAT64" },
  { name: "device_id", type: "STRING" },
  { name: "model", type: "INT64" },
  { name: "timezone", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const DEVICE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "device_id_hash", type: "STRING", mode: "REQUIRED" },
  { name: "type", type: "STRING" },
  { name: "model", type: "STRING" },
  { name: "model_id", type: "INT64" },
  { name: "battery", type: "STRING" },
  { name: "timezone", type: "STRING" },
  { name: "first_session_at", type: "TIMESTAMP" },
  { name: "last_session_at", type: "TIMESTAMP" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];
