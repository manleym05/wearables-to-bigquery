// Hevy v1 API — write side. Docs: https://api.hevyapp.com/docs (auth via `api-key` header).
//
// Two operations the Worker uses:
//   POST   /v1/routines                       — create a routine; returns full Routine{ id, … }
//   PUT    /v1/routines/{routineId}           — update an existing routine
//   POST   /v1/routine_folders                — create a "Life HQ" folder (one-time bootstrap)
//   GET    /v1/routine_folders                — list folders (used by /ensure-folder helper)
//
// Body shape gotchas:
//   * Request body MUST be wrapped: { "routine": { … } }  (or { "routine_folder": { … } })
//   * Response is ALSO wrapped in practice (despite the OpenAPI spec showing the bare entity).
//     The unwrap() helper accepts both shapes so we're safe either way.
//   * NO `rpe` field on PostRoutinesRequestSet / PutRoutinesRequestSet — RPE lives in the
//     exercise `notes` string.
//   * `folder_id` is a NUMBER (not string), nullable.
//   * Reps can use `reps: integer` or `rep_range: { start, end }` (both nullable).
//   * Notes containing "@" reportedly cause silent 400 — we sanitize before sending.

export type RoutineSetType = "warmup" | "normal" | "failure" | "dropset";

export interface RoutineSet {
  type: RoutineSetType;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  custom_metric?: number | null;
  rep_range?: { start: number; end: number } | null;
}

export interface RoutineExercise {
  exercise_template_id: string;
  superset_id?: number | null;
  rest_seconds?: number | null;
  notes?: string | null;
  sets: RoutineSet[];
}

export interface RoutineBody {
  title: string;
  folder_id?: number | null;
  notes?: string;
  exercises: RoutineExercise[];
}

export interface RoutineResponse {
  id: string;
  title: string;
  folder_id: number | null;
  updated_at: string;
  created_at: string;
  exercises: unknown[];
}

/** Strip characters known to trip Hevy's parser (@), normalize whitespace. */
export function sanitizeNotes(s: string | null | undefined): string | null {
  if (s == null) return null;
  const cleaned = String(s).replace(/@/g, "at ").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned;
}

interface HevyEnv {
  apiKey: string;
  apiBase: string;
}

// Hevy's actual responses come in THREE shapes depending on the endpoint (verified empirically
// against api.hevyapp.com 2026-05-26, despite the published OpenAPI spec showing the bare
// entity for all of them):
//   - POST /v1/routines              → [ { id, title, … } ]                   ← single-element array
//   - POST /v1/routine_folders       → { routine_folder: { id, title, … } }   ← envelope
//   - GET  /v1/routine_folders       → { routine_folders: [ {…}, … ] }        ← list (handled inline)
// unwrap() handles all three: array → take [0]; envelope → take body[key]; bare → return as-is.
function unwrap<T>(body: unknown, key: string): T {
  if (Array.isArray(body)) {
    return (body[0] ?? null) as T;
  }
  if (body && typeof body === "object" && key in (body as Record<string, unknown>)) {
    return (body as Record<string, T>)[key];
  }
  return body as T;
}

// Hevy's actual POST /v1/routines response shape (verified via wrangler tail 2026-05-26):
//   { "routine": [ { id, title, folder_id, exercises, … } ] }
// — wrapper object containing a one-element ARRAY. The OpenAPI spec shows the bare Routine
// entity, which is wrong. Defensive parsing accepts all reasonable shapes.
function pickRoutine(resp: unknown): RoutineResponse {
  // Shape 1: bare array of one Routine — [{...}]
  if (Array.isArray(resp)) {
    return resp[0] as RoutineResponse;
  }
  if (resp && typeof resp === "object") {
    const r = (resp as Record<string, unknown>).routine;
    // Shape 2: envelope + array — { routine: [{...}] }  ← what Hevy actually returns
    if (Array.isArray(r)) return r[0] as RoutineResponse;
    // Shape 3: envelope + object — { routine: {...} }
    if (r && typeof r === "object") return r as RoutineResponse;
  }
  // Shape 4: bare object — {id, ...}   (what the OpenAPI spec claims)
  return resp as RoutineResponse;
}

export async function createRoutine(env: HevyEnv, body: RoutineBody): Promise<RoutineResponse> {
  const resp: unknown = await call<unknown>(env, "POST", "/v1/routines", { routine: body });
  return pickRoutine(resp);
}

export async function updateRoutine(
  env: HevyEnv, routineId: string, body: Omit<RoutineBody, "folder_id">,
): Promise<RoutineResponse> {
  // PUT body shape per spec: same wrapper, NO folder_id field (folder is fixed at creation).
  const resp: unknown = await call<unknown>(env, "PUT", `/v1/routines/${encodeURIComponent(routineId)}`, {
    routine: body,
  });
  return pickRoutine(resp);
}

export interface RoutineFolder { id: number; index: number; title: string; updated_at: string; created_at: string }

export async function listFolders(env: HevyEnv): Promise<RoutineFolder[]> {
  const out: RoutineFolder[] = [];
  for (let page = 1; page < 40; page++) {
    const body = await call<{ page_count?: number; routine_folders?: unknown[] }>(
      env, "GET", `/v1/routine_folders?page=${page}&pageSize=10`, null);
    const raw = body.routine_folders ?? [];
    const folders = raw.map((r) => unwrap<RoutineFolder>(r, "routine_folder"));
    out.push(...folders);
    if (folders.length === 0 || page >= (body.page_count ?? page)) break;
  }
  return out;
}

export async function createFolder(env: HevyEnv, title: string): Promise<RoutineFolder> {
  const resp = await call<unknown>(env, "POST", "/v1/routine_folders", {
    routine_folder: { title },
  });
  return unwrap<RoutineFolder>(resp, "routine_folder");
}

async function call<T>(env: HevyEnv, method: string, path: string, body: unknown): Promise<T> {
  const url = `${env.apiBase}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "api-key": env.apiKey,
      "content-type": "application/json",
      "accept": "application/json",
    },
  };
  if (body != null) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new HevyApiError(res.status, method, path, text);
  }
  // Some endpoints return 204; cast tightly here only for the JSON-returning ones we use.
  return (await res.json()) as T;
}

export class HevyApiError extends Error {
  constructor(public status: number, public method: string, public path: string, public body: string) {
    super(`Hevy ${method} ${path} → HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "HevyApiError";
  }
}
