// cornerstone-bq-query — token-authed, read-only BigQuery query Worker.
//
// Purpose: let Life HQ (and any future consumer) read life_ops via a bearer token instead of
// loading the GCP service-account private key into model context on every render. Mirrors the
// cornerstone-maps pattern: SA held server-side, token-gated HTTPS, JSON out.
//
// Routes (all except /healthz and / require ?token= or Authorization: Bearer):
//   GET  /healthz                      -> "ok"
//   GET  /queries                      -> list named queries + their params
//   GET  /named?name=<id>&<param>=...  -> run a named query (params from query string)
//   POST /named   {name, params}       -> run a named query (params from JSON)
//   POST /sql     {sql, params?, maxBytes?} -> run an arbitrary single read-only SELECT/WITH
//
// Read-only is enforced two ways: (1) the SA has dataViewer+jobUser only (no write), (2) /sql
// validates the statement is a single SELECT/WITH. Cost is capped by MAX_BYTES_BILLED.

import type { Env } from "./env";
import { getGcpAccessToken } from "./jwt";
import { runQuery } from "./bq";
import { assertReadOnly, buildQueryParameters } from "./validate";
import { NAMED_QUERIES } from "./queries";
import { HttpError } from "./errors";

const RESERVED_PARAMS = new Set(["name", "token", "maxbytes"]);

const USAGE = [
  "cornerstone-bq-query — read-only BigQuery over life_ops",
  "  GET  /healthz",
  "  GET  /queries?token=…",
  "  GET  /named?name=<id>&<param>=<value>&token=…",
  "  POST /named   { name, params }            (Authorization: Bearer …)",
  "  POST /sql     { sql, params?, maxBytes? } (single read-only SELECT/WITH)",
].join("\n");

function checkAuth(env: Env, url: URL, req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
  if (!env.QUERY_TOKEN || !timingSafeEqual(token, env.QUERY_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

// Constant-time string compare (length is allowed to leak; contents are not).
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(USAGE, { status: 200, headers: { "content-type": "text/plain" } });
    }

    const denied = checkAuth(env, url, req);
    if (denied) return denied;

    try {
      switch (url.pathname) {
        case "/queries":
          return json({
            queries: Object.entries(NAMED_QUERIES).map(([id, q]) => ({
              id, description: q.description, params: q.params,
            })),
          });
        case "/named":
          return await handleNamed(req, env, url);
        case "/sql":
          return await handleSql(req, env);
        default:
          return new Response("not found — try /healthz, /queries, /named, /sql", { status: 404 });
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return new Response(`query failed: ${(err as Error).message}`, { status });
    }
  },
};

async function handleNamed(req: Request, env: Env, url: URL): Promise<Response> {
  let name = url.searchParams.get("name") ?? "";
  let rawParams: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (RESERVED_PARAMS.has(k.toLowerCase())) continue;
    rawParams[k] = v;
  }
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; params?: Record<string, unknown> };
    if (body.name) name = body.name;
    if (body.params) rawParams = { ...rawParams, ...body.params };
  }

  const def = NAMED_QUERIES[name];
  if (!def) throw new HttpError(400, `unknown named query '${name}' (see /queries)`);

  // Type each declared param; always inject subject_id.
  const typed: Record<string, unknown> = {
    subject_id: { type: "INT64", value: Number(env.SUBJECT_ID) },
  };
  for (const [pname, ptype] of Object.entries(def.params)) {
    if (!(pname in rawParams)) throw new HttpError(400, `missing param '${pname}' for '${name}'`);
    typed[pname] = { type: ptype, value: rawParams[pname] };
  }

  const accessToken = await getGcpAccessToken(env.GCP_SA_KEY);
  const result = await runQuery({
    projectId: env.GCP_PROJECT,
    accessToken,
    sql: def.sql,
    params: buildQueryParameters(typed),
    maximumBytesBilled: env.MAX_BYTES_BILLED,
  });
  return json({
    ok: true, name,
    rowCount: result.rowCount, totalRows: result.totalRows, truncated: result.truncated,
    fields: result.fields, rows: result.rows,
    totalBytesProcessed: result.totalBytesProcessed, cacheHit: result.cacheHit,
  });
}

async function handleSql(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "/sql requires POST with JSON { sql, params?, maxBytes? }");
  }
  const body = (await req.json().catch(() => null)) as
    | { sql?: string; params?: unknown; maxBytes?: string | number }
    | null;
  if (!body || typeof body.sql !== "string") {
    throw new HttpError(400, "body must be JSON with a 'sql' string");
  }
  const sql = assertReadOnly(body.sql);

  const accessToken = await getGcpAccessToken(env.GCP_SA_KEY);
  const result = await runQuery({
    projectId: env.GCP_PROJECT,
    accessToken,
    sql,
    params: buildQueryParameters(body.params),
    maximumBytesBilled: clampBytes(body.maxBytes, env.MAX_BYTES_BILLED),
  });
  return json({
    ok: true,
    rowCount: result.rowCount, totalRows: result.totalRows, truncated: result.truncated,
    fields: result.fields, rows: result.rows,
    totalBytesProcessed: result.totalBytesProcessed, cacheHit: result.cacheHit,
  });
}

// Clamp a caller-supplied byte cap to the env limit — callers may lower the cost ceiling but
// never raise it above MAX_BYTES_BILLED.
function clampBytes(requested: string | number | undefined, envCap: string): string {
  const cap = Number(envCap);
  if (requested == null) return envCap;
  const r = Number(requested);
  if (!Number.isFinite(r) || r <= 0) return envCap;
  return String(Math.min(r, cap));
}
