// Minimal BigQuery REST query client for Workers.
// Runs a single SELECT via jobs.query, polls/paginates getQueryResults, and shapes the
// {f:[{v}]} wire format into friendly typed row objects so consumers don't parse it.
//
// Robustness:
//  - transient upstream failures (429 / 5xx / network) are retried with backoff
//  - results are paginated up to MAX_ROWS; if the result set is larger, `truncated` is set
//  - upstream errors surface as HttpError(502); the router maps validation errors to 400

import type { NamedParams } from "./validate";
import { HttpError } from "./errors";

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const PAGE_SIZE = 1000;       // rows per BQ page
const MAX_ROWS = 50_000;      // hard cap on rows returned in one response
const MAX_RETRIES = 3;

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; type: string }[];
  rowCount: number;
  totalRows: number | null;
  truncated: boolean;
  totalBytesProcessed: number | null;
  cacheHit: boolean;
}

export interface RunQueryArgs {
  projectId: string;
  accessToken: string;
  sql: string;
  params?: NamedParams;
  maximumBytesBilled?: string;
  timeoutMs?: number;
}

interface BqField { name: string; type: string; mode?: string; fields?: BqField[] }
interface BqCell { v: unknown }
interface BqRow { f: BqCell[] }
interface BqQueryResponse {
  jobComplete: boolean;
  jobReference?: { jobId: string; location?: string };
  schema?: { fields: BqField[] };
  rows?: BqRow[];
  pageToken?: string;
  totalRows?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
  errors?: unknown[];
}

// fetch with retry on transient failures (429, 5xx, network). Returns parsed JSON or throws 502.
async function bqFetch(url: string, init: RequestInit): Promise<BqQueryResponse> {
  let lastErr = "";
  let delay = 400;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = `network: ${(e as Error).message}`;
      if (attempt === MAX_RETRIES) break;
      await sleep(delay); delay = Math.min(delay * 2, 4000); continue;
    }
    if (res.ok) {
      const json = (await res.json()) as BqQueryResponse;
      if (json.errors && json.errors.length) {
        throw new HttpError(502, `bq query errors: ${JSON.stringify(json.errors)}`);
      }
      return json;
    }
    const bodyText = await res.text();
    // Retry transient statuses; fail fast on 4xx (bad query / auth).
    if (res.status === 429 || res.status >= 500) {
      lastErr = `bq ${res.status}: ${bodyText}`;
      if (attempt === MAX_RETRIES) break;
      await sleep(delay); delay = Math.min(delay * 2, 4000); continue;
    }
    // Non-retryable upstream error (e.g. 400 invalid SQL, 403 perms) — surface as 502 with detail.
    throw new HttpError(502, `bq ${res.status}: ${bodyText}`);
  }
  throw new HttpError(502, `bq request failed after ${MAX_RETRIES + 1} attempts: ${lastErr}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runQuery(args: RunQueryArgs): Promise<QueryResult> {
  const body: Record<string, unknown> = {
    query: args.sql,
    useLegacySql: false,
    timeoutMs: args.timeoutMs ?? 30000,
    maxResults: PAGE_SIZE,
  };
  if (args.params) {
    body.parameterMode = args.params.parameterMode;
    body.queryParameters = args.params.queryParameters;
  }
  if (args.maximumBytesBilled) body.maximumBytesBilled = args.maximumBytesBilled;

  const authHeader = { authorization: `Bearer ${args.accessToken}` };

  let resp = await bqFetch(`${BQ_BASE}/projects/${args.projectId}/queries`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const jobId = resp.jobReference?.jobId;
  const location = resp.jobReference?.location;
  const bytes = resp.totalBytesProcessed != null ? Number(resp.totalBytesProcessed) : null;
  const cacheHit = resp.cacheHit ?? false;

  // Poll to completion if the inline query timed out.
  const deadline = Date.now() + 55_000;
  while (!resp.jobComplete) {
    if (!jobId) throw new HttpError(502, "bq query incomplete with no jobReference");
    if (Date.now() > deadline) throw new HttpError(504, "bq query did not complete within deadline");
    await sleep(800);
    resp = await getResultsPage(args.projectId, jobId, location, args.accessToken, undefined);
  }

  const schemaFields = resp.schema?.fields ?? [];
  let rows = (resp.rows ?? []).map((r) => shapeRow(r.f, schemaFields));
  let pageToken = resp.pageToken;
  let truncated = false;

  // Follow pages up to MAX_ROWS.
  while (pageToken) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    if (!jobId) break;
    const page = await getResultsPage(args.projectId, jobId, location, args.accessToken, pageToken);
    rows = rows.concat((page.rows ?? []).map((r) => shapeRow(r.f, schemaFields)));
    pageToken = page.pageToken;
  }

  const totalRows = resp.totalRows != null ? Number(resp.totalRows) : rows.length;
  if (totalRows > rows.length) truncated = true;

  return {
    rows,
    fields: schemaFields.map((f) => ({ name: f.name, type: f.type })),
    rowCount: rows.length,
    totalRows,
    truncated,
    totalBytesProcessed: bytes,
    cacheHit,
  };
}

async function getResultsPage(
  projectId: string, jobId: string, location: string | undefined, accessToken: string, pageToken: string | undefined,
): Promise<BqQueryResponse> {
  const qs = new URLSearchParams({ maxResults: String(PAGE_SIZE), timeoutMs: "30000" });
  if (location) qs.set("location", location);
  if (pageToken) qs.set("pageToken", pageToken);
  return bqFetch(`${BQ_BASE}/projects/${projectId}/queries/${jobId}?${qs}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function shapeRow(cells: BqCell[], fields: BqField[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  fields.forEach((f, i) => { obj[f.name] = shapeValue(cells[i]?.v, f); });
  return obj;
}

function shapeValue(v: unknown, field: BqField): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === "REPEATED") {
    const arr = v as { v: unknown }[];
    const scalar: BqField = { name: field.name, type: field.type, fields: field.fields };
    return arr.map((cell) => shapeValue(cell.v, scalar));
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    const rec = v as { f: BqCell[] };
    return shapeRow(rec.f, field.fields ?? []);
  }
  return coerceScalar(v as string, field.type);
}

function coerceScalar(v: string, type: string): unknown {
  switch (type) {
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return Number(v);
    case "BOOLEAN":
    case "BOOL":
      return v === "true" || v === "1";
    case "JSON":
      try { return JSON.parse(v); } catch { return v; }
    default:
      return v; // STRING, DATE, DATETIME, TIMESTAMP, BYTES, GEOGRAPHY, TIME
  }
}
