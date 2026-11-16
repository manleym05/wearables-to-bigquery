// cornerstone-hevy-push — outbound action Worker. First member of Cornerstone's "actions tier".
//
// What it does:
//   The Life HQ agent decides what today's session should look like (gameplan + HRV gate),
//   sends it here, and this Worker pushes it as a Hevy routine via the Hevy v1 API. the owner
//   opens Hevy and the workout is already there. His logged sets flow back via the existing
//   `cornerstone-hevy` ingest Worker — the loop closes.
//
// Routes:
//   GET  /healthz                    — liveness
//   POST /push-routine               — main action; admin-token auth; idempotent by key
//   POST /ensure-folder              — one-time bootstrap; ensure a "Life HQ" routine folder
//   GET  /                           — usage banner
//
// Auth (all non-GET-/healthz): bearer admin token, identical to cornerstone-maps.
// Idempotency: client supplies an `idempotency_key`; the Worker looks up the last successful
// `life_ops.action_log` row for that (subject_id, action_type, idempotency_key) and either
// PUTs the existing Hevy routine (if found) or POSTs a new one.
//
// Audit: every push (success, validation_failed, skipped on RED, vendor error) writes a row
// to `life_ops.action_log`. That table is the single source of truth across all action workers
// — grocery ordering, calendar writes, etc. will all write the same shape.

import type { Env } from "./env";
import { getGcpAccessToken } from "./jwt";
import { composeRoutine, normalizeIntent, VALID_INTENTS, type PushRoutineInput } from "./routine";
import { acceptedVocabulary } from "./exercise-map";
import {
  createRoutine, updateRoutine, listFolders, createFolder, HevyApiError,
  type RoutineBody, type RoutineResponse,
} from "./hevy";
import { findLastSuccess, writeActionLog, sha256Hex, getLastSessionWeights, type ActionLogRow } from "./bq";

const ACTION_TYPE = "hevy_push_routine";
const HEVY_FOLDER_TITLE = "Life HQ";

const USAGE = [
  "cornerstone-hevy-push — push Life HQ prescriptions into Hevy as routines",
  "  GET  /healthz",
  "  GET  /contract                (Authorization: Bearer …)",
  "        the full payload contract + accepted exercise vocabulary. Call this instead of guessing.",
  "  POST /push-routine            (Authorization: Bearer …)",
  "        body: { date, training_day, gate, idempotency_key, exercises[],",
  "                intent?, title?, notes?, gate_modifier? }",
  "  POST /ensure-folder           (Authorization: Bearer …)",
  "        ensures the 'Life HQ' routine folder exists; returns its numeric id",
].join("\n");

/**
 * Machine-readable field contract, returned on every 400 and from GET /contract.
 *
 * P4b (2026-07-26): `date` and `training_day` were required but undocumented, and `gameplan_name`
 * had to be spelled exactly — three rejection rounds in one live Sunday session. Required fields
 * now announce themselves in the failure body.
 */
const PAYLOAD_CONTRACT = {
  required: {
    date: "YYYY-MM-DD — 400 without it",
    training_day: "string, e.g. 'Upper' or 'Day 2 Lower (Strength bias)' — 400 without it",
    gate: "one of ALLOWED_GATES (GREEN | YELLOW | AMBER | RED)",
    idempotency_key: "string — stable per logical push; re-sending updates the same Hevy routine",
    "exercises[]": "non-empty array",
    "exercises[].gameplan_name": "canonical name — `name` is accepted as an alias. 422 + accepted_exercises on a miss",
    "exercises[].sets": "integer >= 1",
  },
  optional: {
    intent: `${VALID_INTENTS.join(" | ")} — default 'full'. Rendered into the generated title (e.g. 'DELOAD'). A misspelling is a 400, not a silent fallback.`,
    title: "string — HONOURED VERBATIM when supplied; otherwise generated from date/intent/training_day/gate",
    notes: "string — leads the Hevy routine notes; the generated gate/caps line is appended after it",
    gate_modifier: "string — diagnostic label, rendered into the notes",
    "exercises[].reps": "string — '5' | '6-8' | '8-10 ea' | null",
    "exercises[].rpe": "number | null — rendered into the exercise note (Hevy has no per-set RPE field)",
    "exercises[].note": "string — per-exercise note",
    "exercises[].target_weight_lb": "number — lb; converted to kg. Defaults to last logged top weight",
    "exercises[].set_weights_lb": "number[] — per-set override; index 0 = first set",
    "exercises[].rest_seconds": "number — inter-set timer; defaults by movement pattern (150 compound / 75 accessory / 30 core)",
  },
  notes: [
    "gate=RED short-circuits: nothing is pushed, a 'skipped' action_log row is written, response is 200.",
    "Re-sending the same idempotency_key PUTs the existing routine rather than creating a duplicate.",
  ],
} as const;

function checkAuth(env: Env, url: URL, req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

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
      return new Response(USAGE, { headers: { "content-type": "text/plain" } });
    }

    const denied = checkAuth(env, url, req);
    if (denied) return denied;

    try {
      if (url.pathname === "/push-routine") return await handlePush(req, env);
      if (url.pathname === "/ensure-folder") return await handleEnsureFolder(env);
      // Discovery: everything a caller needs to build a valid payload, in one GET.
      if (url.pathname === "/contract") {
        return json({
          ok: true,
          contract: PAYLOAD_CONTRACT,
          allowed_gates: env.ALLOWED_GATES.split(",").map((s) => s.trim().toUpperCase()),
          valid_intents: VALID_INTENTS,
          accepted_exercises: acceptedVocabulary(),
        });
      }
      return new Response("not found — see /", { status: 404 });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(JSON.stringify({ kind: "unhandled", err: msg }));
      return new Response(`hevy-push failed: ${msg}`, { status: 500 });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
async function handleEnsureFolder(env: Env): Promise<Response> {
  const hevyEnv = { apiKey: env.HEVY_API_KEY, apiBase: env.HEVY_API_BASE };
  const folders = await listFolders(hevyEnv);
  const existing = folders.find((f) => f.title === HEVY_FOLDER_TITLE);
  if (existing) {
    return json({ ok: true, created: false, folder_id: existing.id, title: existing.title });
  }
  const created = await createFolder(hevyEnv, HEVY_FOLDER_TITLE);
  return json({
    ok: true, created: true, folder_id: created.id, title: created.title,
    note: `Set HEVY_FOLDER_ID=${created.id} in wrangler.toml [vars] and redeploy.`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function handlePush(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("/push-routine requires POST", { status: 405 });
  }
  const startedAt = new Date();
  const subjectId = Number(env.SUBJECT_ID);
  const allowedGates = new Set(env.ALLOWED_GATES.split(",").map((s) => s.trim().toUpperCase()));

  let parsed: PushRoutineInput | null = null;
  try {
    parsed = (await req.json()) as PushRoutineInput;
  } catch {
    return json({ ok: false, error: "body must be JSON" }, 400);
  }

  // ── Minimal pre-compose validation
  const validation: string[] = [];
  if (!parsed || typeof parsed !== "object") validation.push("body must be an object");
  if (!parsed?.date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) validation.push("date must be YYYY-MM-DD");
  if (!parsed?.training_day || typeof parsed.training_day !== "string") validation.push("training_day required");
  if (!parsed?.gate || !allowedGates.has(parsed.gate)) validation.push(`gate must be one of ${env.ALLOWED_GATES}`);
  if (!parsed?.idempotency_key || typeof parsed.idempotency_key !== "string") validation.push("idempotency_key required");
  if (!Array.isArray(parsed?.exercises) || parsed.exercises.length === 0) validation.push("exercises[] required, non-empty");
  // `intent` is optional, but a MISSPELLED intent must not silently fall back to "full" — that is
  // exactly the deload-reads-as-full-plan failure this field exists to prevent (P4a).
  // NB: compare as unknown — callers are untrusted JSON, so `intent` can be any value at runtime
  // regardless of what the TS type claims.
  if ((parsed?.intent as unknown) != null && (parsed?.intent as unknown) !== "" && normalizeIntent(parsed?.intent) == null) {
    validation.push(`intent must be one of ${VALID_INTENTS.join(" | ")} (got ${JSON.stringify(parsed.intent)})`);
  }

  if (validation.length > 0) {
    await tryAudit(env, {
      ts: startedAt.toISOString(), action_type: ACTION_TYPE, subject_id: subjectId,
      target_date: parsed?.date ?? null, gate: parsed?.gate ?? null,
      status: "validation_failed", external_id: null,
      idempotency_key: parsed?.idempotency_key ?? null,
      payload_json: JSON.stringify(parsed ?? {}),
      response_json: null, payload_hash: null, http_status: 400,
      error: validation.join("; "), worker: env.WORKER_VERSION, raw_request_id: req.headers.get("x-request-id"),
    });
    // Hand back the full field contract, not just the failures — a 400 should be self-correcting.
    return json({ ok: false, errors: validation, contract: PAYLOAD_CONTRACT }, 400);
  }

  const folderId =
    env.HEVY_FOLDER_ID && env.HEVY_FOLDER_ID.trim() !== "" ? Number(env.HEVY_FOLDER_ID) : null;

  // ── Last-logged reference (progressive overload): for EACH exercise, the top weight + reps from
  // the most recent day it was logged, across ALL sessions, keyed by template_id. The composer
  // defaults the routine weight to it (the owner bumps from there) + adds a "last Xlb (reps)" note.
  // (Was scoped to the last same-type-*titled* session, but Hevy workout titles aren't the gameplan
  // day names, so Lower days seeded almost nothing.) Best-effort — empty map = no defaults.
  const gcpToken = await getGcpAccessToken(env.GCP_SA_KEY);
  const lastWeights = await getLastSessionWeights(env.GCP_PROJECT, env.BQ_DATASET, subjectId, parsed!.date, gcpToken)
    .catch(() => new Map<string, { lb: number; reps: string }>());

  // ── Compose the Hevy body (resolve names → ids, apply gate, parse reps, sanitize notes)
  const composed = composeRoutine(parsed!, Number.isFinite(folderId) ? folderId : null, lastWeights);

  if (!composed.ok && composed.skipped) {
    // Gate = RED. Persist a "skipped" row; don't call Hevy.
    await tryAudit(env, {
      ts: startedAt.toISOString(), action_type: ACTION_TYPE, subject_id: subjectId,
      target_date: parsed!.date, gate: parsed!.gate,
      status: "skipped", external_id: null,
      idempotency_key: parsed!.idempotency_key,
      payload_json: JSON.stringify(parsed),
      response_json: null, payload_hash: null, http_status: null,
      error: composed.reason, worker: env.WORKER_VERSION, raw_request_id: req.headers.get("x-request-id"),
    });
    return json({ ok: true, status: "skipped", note: composed.reason });
  }

  if (!composed.ok && !composed.skipped) {
    await tryAudit(env, {
      ts: startedAt.toISOString(), action_type: ACTION_TYPE, subject_id: subjectId,
      target_date: parsed!.date, gate: parsed!.gate,
      status: "validation_failed", external_id: null,
      idempotency_key: parsed!.idempotency_key,
      payload_json: JSON.stringify(parsed),
      response_json: JSON.stringify({ errors: composed.errors }),
      payload_hash: null, http_status: 422,
      error: composed.errors.map((e) => e.message).join("; "),
      worker: env.WORKER_VERSION, raw_request_id: req.headers.get("x-request-id"),
    });
    // P4b: return the ACCEPTED VOCABULARY on an unknown-exercise 422 so the caller fixes it in one
    // round. Previously the body carried only "no mapping for X", which cost three rejection rounds
    // when a push fails. Only attached when the failure is actually a name problem —
    // no need to ship 60 names on a bad_field error.
    const nameProblem = composed.errors.some((e) => e.code === "unknown_exercise");
    return json({
      ok: false,
      errors: composed.errors,
      ...(nameProblem ? { accepted_exercises: acceptedVocabulary() } : {}),
    }, 422);
  }

  const body = (composed as Extract<typeof composed, { ok: true }>).body;
  const title = (composed as Extract<typeof composed, { ok: true }>).title;
  const intent = (composed as Extract<typeof composed, { ok: true }>).intent;
  const modifier_label = (composed as Extract<typeof composed, { ok: true }>).modifier_label;

  // ── Idempotency lookup: did we already push this key successfully? (reuses gcpToken from above)
  const prior = await findLastSuccess(
    env.GCP_PROJECT, env.BQ_DATASET, subjectId, ACTION_TYPE, parsed!.idempotency_key, gcpToken,
  );

  const hevyEnv = { apiKey: env.HEVY_API_KEY, apiBase: env.HEVY_API_BASE };

  let routineResp: RoutineResponse | undefined;
  let httpStatus = 0;
  let actionStatus: "success" | "error" = "success";
  let errMsg: string | null = null;
  let externalId: string | null = null;
  // Self-heal bookkeeping — surfaced in response so the owner can update wrangler.toml / debug if recovery fired.
  let folderIdUsed: number | null = body.folder_id ?? null;
  let folderRecovered = false;
  let folderRecoveryNote: string | null = null;
  let put404Recovered = false;
  let put404RecoveryNote: string | null = null;
  let stalePutRoutineId: string | null = null;
  // Path tracker: which Hevy call actually landed the routine.
  let resolvedVia: "put" | "post" | "post_after_put_404" = "post";

  try {
    if (prior?.external_id) {
      // PUT — same routine, updated body. Strip folder_id (Hevy ignores it on PUT).
      const putBody: Omit<typeof body, "folder_id"> = {
        title: body.title, notes: body.notes, exercises: body.exercises,
      };
      try {
        routineResp = await updateRoutine(hevyEnv, prior.external_id, putBody);
        httpStatus = 200;
        externalId = routineResp.id;
        resolvedVia = "put";
      } catch (err) {
        // PUT 404 = cached routine_id points to a routine the owner deleted in the Hevy app.
        // Self-heal: fall back to POST (via createWithFolderHeal so folder healing still applies).
        // The fresh POST writes a new action_log row → the new routine_id becomes the
        // "cache" entry for subsequent pushes with this idempotency_key. Mirror of the
        // folder-id self-heal pattern below.
        if (!(err instanceof HevyApiError) || err.status !== 404) {
          throw err;
        }
        console.error("PH1", JSON.stringify({
          kind: "put_404_self_heal", stale_routine_id: prior.external_id,
        }));
        stalePutRoutineId = prior.external_id;
        put404Recovered = true;
        put404RecoveryNote =
          `Cached routine_id ${prior.external_id} returned 404 on PUT — routine was deleted in the Hevy app. Recreated via POST.`;
        resolvedVia = "post_after_put_404";
      }
    }

    if (resolvedVia !== "put") {
      const result = await createWithFolderHeal(hevyEnv, body);
      routineResp = result.resp;
      httpStatus = 201;
      externalId = routineResp.id;
      folderIdUsed = result.folderIdUsed;
      folderRecovered = result.recovered;
      folderRecoveryNote = result.note;
    }
  } catch (err) {
    actionStatus = "error";
    if (err instanceof HevyApiError) {
      httpStatus = err.status;
      errMsg = err.message;
    } else {
      errMsg = (err as Error).message;
    }
  }

  // Compose payload_json after the try block so self-heal observability flags land in the audit row.
  const payloadJson = JSON.stringify({
    input: parsed,
    hevy_body: body,
    ...(put404Recovered
      ? { self_heal: { put_404: { stale_routine_id: stalePutRoutineId, note: put404RecoveryNote } } }
      : {}),
  });
  const payloadHash = await sha256Hex(payloadJson);

  await tryAudit(env, {
    ts: startedAt.toISOString(), action_type: ACTION_TYPE, subject_id: subjectId,
    target_date: parsed!.date, gate: parsed!.gate,
    status: actionStatus, external_id: externalId,
    idempotency_key: parsed!.idempotency_key,
    payload_json: payloadJson,
    response_json: routineResp ? JSON.stringify(routineResp) : null,
    payload_hash: payloadHash, http_status: httpStatus,
    error: errMsg, worker: env.WORKER_VERSION, raw_request_id: req.headers.get("x-request-id"),
  });

  if (actionStatus === "error") {
    return json({ ok: false, error: errMsg, http_status: httpStatus }, httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502);
  }

  const verb = resolvedVia === "put" ? "updated" : "created";
  return json({
    ok: true,
    status: verb,
    routine_id: externalId,
    hevy_url: externalId ? `https://app.hevy.com/routine/${externalId}` : null,
    title,
    intent,
    title_source: typeof parsed!.title === "string" && parsed!.title.trim() !== "" ? "caller" : "generated",
    notes_source: typeof parsed!.notes === "string" && parsed!.notes.trim() !== "" ? "caller+generated" : "generated",
    note: modifier_label,
    idempotency_key: parsed!.idempotency_key,
    folder_id_used: folderIdUsed,
    folder_recovered: folderRecovered,
    folder_recovery_note: folderRecoveryNote,
    put_404_recovered: put404Recovered,
    put_404_recovery_note: put404RecoveryNote,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Folder self-heal — when Hevy returns 400 "Invalid routine folder id" on POST,
// re-bootstrap "Life HQ" and retry. Falls back to root (no folder) if the
// re-bootstrap also fails. Idempotent: each Hevy POST is independent — a failed
// POST creates no routine, so retry is safe.
const HEVY_FOLDER_TITLE_FOR_HEAL = "Life HQ";

interface FolderHealResult {
  resp: RoutineResponse;
  folderIdUsed: number | null;
  recovered: boolean;          // true if we had to deviate from the requested folder_id
  note: string | null;         // human-readable explanation for the agent / the owner
}

async function createWithFolderHeal(
  hevyEnv: { apiKey: string; apiBase: string },
  body: RoutineBody,
): Promise<FolderHealResult> {
  try {
    const resp = await createRoutine(hevyEnv, body);
    return { resp, folderIdUsed: body.folder_id ?? null, recovered: false, note: null };
  } catch (err) {
    if (!(err instanceof HevyApiError) || err.status !== 400 || !/Invalid routine folder id/i.test(err.body)) {
      throw err;
    }
    console.error("FH1", JSON.stringify({ kind: "invalid_folder_id", attempted: body.folder_id ?? null }));

    // Step 1: list + find / create the Life HQ folder.
    let newFolderId: number | null = null;
    try {
      const folders = await listFolders(hevyEnv);
      const existing = folders.find((f) => f.title === HEVY_FOLDER_TITLE_FOR_HEAL);
      if (existing) {
        newFolderId = existing.id;
      } else {
        const created = await createFolder(hevyEnv, HEVY_FOLDER_TITLE_FOR_HEAL);
        newFolderId = created.id;
      }
      console.error("FH2", JSON.stringify({ kind: "folder_resolved", new_folder_id: newFolderId }));
    } catch (_e) {
      // List/create itself failed — fall through to root push.
    }

    // Step 2: retry with the new folder_id if we got one.
    if (newFolderId != null && newFolderId !== body.folder_id) {
      try {
        const resp = await createRoutine(hevyEnv, { ...body, folder_id: newFolderId });
        return {
          resp,
          folderIdUsed: newFolderId,
          recovered: true,
          note: `Hevy "Life HQ" folder was re-bootstrapped — update wrangler.toml [vars] HEVY_FOLDER_ID="${newFolderId}" and redeploy.`,
        };
      } catch (_e2) {
        // fall through to root push
      }
    }

    // Step 3: last resort — push to root (folder_id null). Routine still lands.
    const resp = await createRoutine(hevyEnv, { ...body, folder_id: null });
    return {
      resp,
      folderIdUsed: null,
      recovered: true,
      note: `Hevy folder lookup + re-bootstrap failed; routine pushed to root (default "My Routines"). Investigate Hevy state.`,
    };
  }
}

// Best-effort audit — log to console on failure; never throw out of the request path.
async function tryAudit(env: Env, row: ActionLogRow): Promise<void> {
  try {
    const token = await getGcpAccessToken(env.GCP_SA_KEY);
    await writeActionLog(env.GCP_PROJECT, env.BQ_DATASET, row, token);
  } catch (err) {
    console.error(JSON.stringify({ kind: "audit_failed", row_status: row.status, err: (err as Error).message }));
  }
}

