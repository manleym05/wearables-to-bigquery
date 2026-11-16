// Minimal BigQuery REST client for Workers.
// - loadJsonRows: multipart upload of NDJSON into a table (WRITE_TRUNCATE on staging).
// - runQuery: POST jobs.query for MERGE statements.

import { getAccessToken } from "./jwt";

type TableSchemaField =
  | { name: string; type: "STRING" | "INT64" | "FLOAT64" | "BOOL" | "DATE" | "TIMESTAMP" | "JSON"; mode?: "NULLABLE" | "REQUIRED" | "REPEATED" };

export interface LoadJobArgs {
  projectId: string;
  datasetId: string;
  tableId: string;
  rows: object[];
  schema: TableSchemaField[];
  accessToken: string;
}

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_UPLOAD = "https://bigquery.googleapis.com/upload/bigquery/v2";

export async function getToken(saKey: string): Promise<string> {
  return getAccessToken(saKey);
}

// Load NDJSON rows into a table with WRITE_TRUNCATE. Polls until DONE.
export async function loadJsonRows(args: LoadJobArgs): Promise<void> {
  const { projectId, datasetId, tableId, rows, schema, accessToken } = args;

  if (rows.length === 0) {
    // Truncate the staging table anyway so a stale prior batch doesn't get re-MERGED.
    await truncateTable(projectId, datasetId, tableId, schema, accessToken);
    return;
  }

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
  if (!res.ok) {
    throw new Error(`bq load job submit ${res.status}: ${await res.text()}`);
  }
  const job = (await res.json()) as { jobReference: { jobId: string; location?: string } };
  await waitForJob(projectId, job.jobReference.jobId, job.jobReference.location, accessToken);
}

// Run a synchronous query (MERGE / DDL). Uses jobs.query with a generous timeout
// and falls back to polling if BQ returns jobComplete=false.
export async function runQuery(
  projectId: string,
  sql: string,
  accessToken: string,
): Promise<void> {
  const url = `${BQ_BASE}/projects/${projectId}/queries`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
    }),
  });
  if (!res.ok) {
    throw new Error(`bq query ${res.status}: ${await res.text()}`);
  }
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

export async function dropTable(
  projectId: string,
  datasetId: string,
  tableId: string,
  accessToken: string,
): Promise<void> {
  const url = `${BQ_BASE}/projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`bq drop table ${res.status}: ${await res.text()}`);
  }
}

async function waitForJob(
  projectId: string,
  jobId: string,
  location: string | undefined,
  accessToken: string,
): Promise<void> {
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
      if (job.status.errorResult) {
        throw new Error(`bq job failed: ${job.status.errorResult.message}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  throw new Error(`bq job ${jobId} did not complete within 60s`);
}

// Truncate a staging table by submitting an empty-data load with WRITE_TRUNCATE.
async function truncateTable(
  projectId: string,
  datasetId: string,
  tableId: string,
  schema: TableSchemaField[],
  accessToken: string,
): Promise<void> {
  const jobConfig = {
    configuration: {
      load: {
        destinationTable: { projectId, datasetId, tableId },
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        writeDisposition: "WRITE_TRUNCATE",
        createDisposition: "CREATE_IF_NEEDED",
        schema: { fields: schema },
      },
    },
  };
  const boundary = "----cornerstone-" + crypto.randomUUID();
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(jobConfig) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    `\r\n--${boundary}--\r\n`;
  const url = `${BQ_UPLOAD}/projects/${projectId}/jobs?uploadType=multipart`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`bq truncate ${res.status}: ${await res.text()}`);
  const job = (await res.json()) as { jobReference: { jobId: string; location?: string } };
  await waitForJob(projectId, job.jobReference.jobId, job.jobReference.location, accessToken);
}

export const DAILY_STAGING_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "rhr_low_bpm", type: "FLOAT64" },
  { name: "rhr_avg_bpm", type: "FLOAT64" },
  { name: "hrv_avg_ms", type: "FLOAT64" },
  { name: "sleep_total_h", type: "FLOAT64" },
  { name: "sleep_deep_h", type: "FLOAT64" },
  { name: "sleep_rem_h", type: "FLOAT64" },
  { name: "sleep_light_h", type: "FLOAT64" },
  { name: "sleep_efficiency_pct", type: "FLOAT64" },
  { name: "sleep_score", type: "INT64" },
  { name: "readiness_score", type: "INT64" },
  { name: "activity_score", type: "INT64" },
  { name: "steps", type: "INT64" },
  { name: "respiratory_rate", type: "FLOAT64" },
  { name: "body_temp_dev_c", type: "FLOAT64" },
  // enrichment columns (added 2026-05-20)
  { name: "active_calories", type: "INT64" },
  { name: "total_calories", type: "INT64" },
  { name: "avg_met_minutes", type: "FLOAT64" },
  { name: "sedentary_min", type: "INT64" },
  { name: "non_wear_min", type: "INT64" },
  { name: "resting_time_min", type: "INT64" },
  { name: "high_activity_min", type: "INT64" },
  { name: "medium_activity_min", type: "INT64" },
  { name: "low_activity_min", type: "INT64" },
  { name: "equivalent_walking_m", type: "FLOAT64" },
  { name: "temperature_trend_dev_c", type: "FLOAT64" },
  { name: "sleep_contributors_json", type: "JSON" },
  { name: "readiness_contributors_json", type: "JSON" },
  { name: "activity_contributors_json", type: "JSON" },
  // tail
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const DAILY_STRESS_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "stress_high_s", type: "INT64" },
  { name: "recovery_high_s", type: "INT64" },
  { name: "day_summary", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const DAILY_SPO2_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "spo2_avg_pct", type: "FLOAT64" },
  { name: "breathing_disturbance_index", type: "INT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const DAILY_RESILIENCE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "level", type: "STRING" },
  { name: "sleep_recovery", type: "FLOAT64" },
  { name: "daytime_recovery", type: "FLOAT64" },
  { name: "stress_contributor", type: "FLOAT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const DAILY_CARDIO_AGE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "vascular_age_years", type: "INT64" },
  { name: "pulse_wave_velocity", type: "FLOAT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const VO2_MAX_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "measured_at", type: "TIMESTAMP" },
  { name: "vo2_max", type: "FLOAT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const WORKOUT_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "workout_id", type: "STRING", mode: "REQUIRED" },
  { name: "activity", type: "STRING" },
  { name: "intensity", type: "STRING" },
  { name: "start_datetime", type: "TIMESTAMP" },
  { name: "end_datetime", type: "TIMESTAMP" },
  { name: "calories", type: "FLOAT64" },
  { name: "distance_m", type: "FLOAT64" },
  { name: "label", type: "STRING" },
  { name: "oura_source", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const SESSION_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "session_id", type: "STRING", mode: "REQUIRED" },
  { name: "type", type: "STRING" },
  { name: "mood", type: "STRING" },
  { name: "start_datetime", type: "TIMESTAMP" },
  { name: "end_datetime", type: "TIMESTAMP" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const ENHANCED_TAG_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "start_day", type: "DATE", mode: "REQUIRED" },
  { name: "tag_id", type: "STRING", mode: "REQUIRED" },
  { name: "tag_type_code", type: "STRING" },
  { name: "custom_name", type: "STRING" },
  { name: "comment", type: "STRING" },
  { name: "start_time", type: "TIMESTAMP" },
  { name: "end_time", type: "TIMESTAMP" },
  { name: "end_day", type: "DATE" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const REST_MODE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "start_day", type: "DATE", mode: "REQUIRED" },
  { name: "period_id", type: "STRING", mode: "REQUIRED" },
  { name: "end_day", type: "DATE" },
  { name: "start_time", type: "TIMESTAMP" },
  { name: "end_time", type: "TIMESTAMP" },
  { name: "episodes_json", type: "JSON" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const SLEEP_TIME_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "optimal_bedtime_json", type: "JSON" },
  { name: "recommendation", type: "STRING" },
  { name: "status", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const PERSONAL_INFO_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "oura_user_id", type: "STRING" },
  { name: "age", type: "INT64" },
  { name: "weight_kg", type: "FLOAT64" },
  { name: "height_m", type: "FLOAT64" },
  { name: "biological_sex", type: "STRING" },
  { name: "email", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const RING_CONFIG_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "ring_id", type: "STRING", mode: "REQUIRED" },
  { name: "color", type: "STRING" },
  { name: "design", type: "STRING" },
  { name: "hardware_type", type: "STRING" },
  { name: "firmware_version", type: "STRING" },
  { name: "size", type: "INT64" },
  { name: "set_up_at", type: "TIMESTAMP" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

// Intraday HR staging. Two deliberate omissions vs the target table:
//   - no `day`      — derived as DATE(ts,'America/New_York') in the MERGE INSERT (ts is the one source of truth).
//   - no `raw_json` — the target column stays SQL NULL (unpopulated). Loading `null` for a JSON column from
//     NDJSON yields a JSON *null literal* (IS NOT NULL = true), not SQL NULL — so we keep raw_json out of the
//     write path entirely and let the MERGE leave the target column at its SQL-NULL default.
// `source` carries the 'oura' provenance literal.
export const HEARTRATE_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "bpm", type: "INT64" },
  { name: "hr_source", type: "STRING" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const RING_BATTERY_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "ts", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "level", type: "INT64" },
  { name: "charging", type: "BOOL" },
  { name: "in_charger", type: "BOOL" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const SLEEP_STAGING_SCHEMA: TableSchemaField[] = [
  { name: "subject_id", type: "INT64", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "sleep_id", type: "STRING", mode: "REQUIRED" },
  { name: "type", type: "STRING" },
  { name: "bedtime_start", type: "TIMESTAMP" },
  { name: "bedtime_end", type: "TIMESTAMP" },
  { name: "total_sleep_h", type: "FLOAT64" },
  { name: "time_in_bed_h", type: "FLOAT64" },
  { name: "deep_sleep_h", type: "FLOAT64" },
  { name: "rem_sleep_h", type: "FLOAT64" },
  { name: "light_sleep_h", type: "FLOAT64" },
  { name: "awake_h", type: "FLOAT64" },
  { name: "efficiency_pct", type: "FLOAT64" },
  { name: "latency_min", type: "FLOAT64" },
  { name: "avg_hrv_ms", type: "FLOAT64" },
  { name: "hr_lowest_bpm", type: "FLOAT64" },
  { name: "hr_avg_bpm", type: "FLOAT64" },
  { name: "avg_breath_rate", type: "FLOAT64" },
  { name: "restless_periods", type: "INT64" },
  { name: "readiness_score", type: "INT64" },
  { name: "source", type: "STRING", mode: "REQUIRED" },
  { name: "raw_json", type: "JSON" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];
