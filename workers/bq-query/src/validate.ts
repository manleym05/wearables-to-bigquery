// Read-only guard + BigQuery query-parameter builder for the /sql passthrough.
//
// The hard read-only boundary is the SA's IAM (dataViewer + jobUser, no dataEditor) — even a
// crafted write would be denied by BigQuery. This guard is defense-in-depth so obvious mistakes
// fail fast with a clear 400 instead of a 403 from BQ.

import { HttpError } from "./errors";

export interface BqQueryParameter {
  name: string;
  parameterType: { type: string };
  parameterValue: { value: string };
}

export interface NamedParams {
  parameterMode: "NAMED";
  queryParameters: BqQueryParameter[];
}

function stripLeadingComments(s: string): string {
  let r = s.trim();
  for (;;) {
    if (r.startsWith("--")) {
      const nl = r.indexOf("\n");
      r = nl === -1 ? "" : r.slice(nl + 1).trim();
      continue;
    }
    if (r.startsWith("/*")) {
      const end = r.indexOf("*/");
      r = end === -1 ? "" : r.slice(end + 2).trim();
      continue;
    }
    break;
  }
  return r;
}

// Ensure `sql` is a single read-only statement. Returns the SQL unchanged or throws.
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, ""); // tolerate one trailing semicolon
  if (trimmed.length === 0) throw new HttpError(400, "empty query");
  // No second statement: a single SELECT/CTE cannot contain DML/DDL, so any remaining ';'
  // means a multi-statement script — reject it.
  if (trimmed.includes(";")) throw new HttpError(400, "only a single statement is allowed (no ';')");
  // Must begin (after any leading comments) with SELECT or WITH.
  const head = stripLeadingComments(trimmed);
  if (!/^(SELECT|WITH)\b/i.test(head)) {
    throw new HttpError(400, "query must start with SELECT or WITH (read-only)");
  }
  return trimmed;
}

// Build BigQuery NAMED query parameters from caller input.
//  - array  -> assumed to already be in BQ queryParameters shape, passed through
//  - object -> each entry becomes a NAMED param. Value may be a scalar (type inferred) or a
//              typed form { type: "DATE", value: "2026-05-25" }.
export function buildQueryParameters(params: unknown): NamedParams | undefined {
  if (params == null) return undefined;
  if (Array.isArray(params)) {
    return { parameterMode: "NAMED", queryParameters: params as BqQueryParameter[] };
  }
  if (typeof params !== "object") throw new HttpError(400, "params must be an object or array");
  const out: BqQueryParameter[] = [];
  for (const [name, raw] of Object.entries(params as Record<string, unknown>)) {
    out.push(toParam(name, raw));
  }
  return { parameterMode: "NAMED", queryParameters: out };
}

function toParam(name: string, raw: unknown): BqQueryParameter {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as Record<string, unknown>)) {
    const o = raw as { type?: string; value: unknown };
    const type = (o.type ?? "STRING").toUpperCase();
    return { name, parameterType: { type }, parameterValue: { value: String(o.value) } };
  }
  let type = "STRING";
  if (typeof raw === "number") type = Number.isInteger(raw) ? "INT64" : "FLOAT64";
  else if (typeof raw === "boolean") type = "BOOL";
  return { name, parameterType: { type }, parameterValue: { value: String(raw) } };
}
