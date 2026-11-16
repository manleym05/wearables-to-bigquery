// Translate the agent's PushRoutineRequest into a Hevy RoutineBody.
//
// Inputs (from index.ts after JSON parse + schema check):
//   { date, training_day, gate, gate_modifier?,
//     exercises: [{ gameplan_name, sets, reps, rpe, note,
//                   target_weight_lb?, set_weights_lb?[], rest_seconds? }],
//     idempotency_key }
//
// Output: { title, folder_id, notes, exercises: [{ exercise_template_id, notes, rest_seconds?, sets: [...] }] }
//
// Key transformations:
//   1. Gameplan name → canonical(s) via exerciseMap (alias / compound resolution).
//   2. Canonical → Hevy exercise_template_id.
//   3. Apply gate modifier (gate.ts) BEFORE rep parsing — the gate may change sets/rpe/notes.
//   4. Parse reps strings ("5", "6-8", "8-10 ea", "—") via reps.ts.
//   5. Build N "normal" sets per exercise (Hevy needs explicit set instances, not a sets-count).
//      Weight resolves per-set from set_weights_lb[i] ?? target_weight_lb; converted lb → kg.
//   6. RPE goes into the exercise notes (no per-set RPE field on Hevy's API).
//   7. rest_seconds attaches to the Hevy exercise (Hevy renders a countdown timer between sets).
//   8. Routine title = "Life HQ — {ShortDay} {M/D} {DayLabel} ({GATE})".

import { resolveGameplanName, templateIdFor, suggestFor } from "./exercise-map";
import { parseReps } from "./reps";
import { applyGate, isStrengthCompound, type Gate, type InputExercise } from "./gate";
import { sanitizeNotes, type RoutineBody, type RoutineExercise, type RoutineSet } from "./hevy";

/**
 * Training intent — what KIND of session this is, independent of the recovery gate.
 * Added 2026-07-26 (Life HQ passback P4a): two deload routines were pushed with explicit deload
 * titles and notes and came back titled "…Upper (GREEN)" / noted "GREEN — full plan". On a
 * 60%-volume deload week "full plan" is actively wrong, and — per P3 — a mislabeled routine title
 * is precisely the failure mode being eliminated elsewhere in the same passback.
 *
 * The gate word answers "how recovered is he?"; intent answers "what is this session for?".
 * They are orthogonal and both belong in the title.
 */
export type Intent = "full" | "deload" | "express" | "travel";

const INTENT_LABEL: Record<Intent, string> = {
  full: "",              // the default — adds nothing to the title
  deload: "DELOAD",      // upper-case: a deload must be unmissable at a glance in the Hevy list
  express: "Express",
  travel: "Travel",
};

export const VALID_INTENTS = Object.keys(INTENT_LABEL) as Intent[];

export function normalizeIntent(raw: unknown): Intent | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (VALID_INTENTS as string[]).includes(v) ? (v as Intent) : null;
}

export interface PushRoutineInput {
  date: string;                                // YYYY-MM-DD
  training_day: string;                        // e.g. "Day 2 Lower (Strength bias)"
  gate: Gate;
  gate_modifier?: string;                      // diagnostic label only
  intent?: Intent;                             // 'full' (default) | 'deload' | 'express' | 'travel'
  title?: string | null;                       // caller-supplied title — HONOURED verbatim when present
  notes?: string | null;                       // caller-supplied routine notes — leads the notes block
  exercises: Array<{
    /** Canonical gameplan vocabulary. `name` is accepted as an alias (see resolveExerciseName). */
    gameplan_name?: string;
    name?: string;
    sets: number;
    reps: string | null;
    rpe: number | null;
    note?: string | null;
    target_weight_lb?: number | null;          // optional — exercise-default weight (in lb; Worker converts to kg)
    /** Alias for `target_weight_lb`. See resolveTargetWeight — a silently-ignored weight is dangerous. */
    weight_lb?: number | null;
    set_weights_lb?: Array<number | null>;     // optional — per-set override; index 0 = first set; missing/null falls back to target_weight_lb
    rest_seconds?: number | null;              // optional — exercise rest timer (seconds)
  }>;
  idempotency_key: string;
}

/** Convert lb → kg with 1-decimal precision (Hevy's display granularity). Null-safe. */
function lbToKg(lb: number | null | undefined): number | null {
  if (lb == null || !Number.isFinite(lb) || lb <= 0) return null;
  return Math.round((lb / 2.20462) * 10) / 10;
}

// Core / anti-rotation movements — short inter-set rest.
const CORE_REST_RE = /\b(plank|pallof|hollow|dead\s?bug|ab[s]?|crunch|sit[-\s]?up|anti[-\s]?rotation|woodchop)\b/i;

/**
 * Default inter-set rest (seconds) when the payload omits `rest_seconds`. Hevy renders a
 * countdown timer between sets; the owner wants EVERY pushed routine to carry one (added 2026-06-22 —
 * manual pushes were sending no rest, so the app showed no timer). An explicit `rest_seconds`
 * in the payload always wins; this only fills the gap so no exercise ships timer-less.
 *
 * Pattern-based: heavy compounds get full recovery, accessories moderate, core short.
 */
function defaultRestSeconds(canonicalName: string): number {
  if (CORE_REST_RE.test(canonicalName)) return 30;       // core / anti-rotation
  if (isStrengthCompound(canonicalName)) return 150;     // squat/dl/bench/press/row/pull-up — full recovery
  return 75;                                             // accessories (curls, raises, flyes, extensions, calves)
}

export interface ValidationError {
  code: "unknown_exercise" | "bad_field" | "no_exercises_after_gate" | "skipped_red";
  message: string;
  field?: string;
  /** Close matches from the accepted vocabulary, so the caller can fix it in one round. */
  suggestions?: string[];
}

/**
 * Accept either `gameplan_name` (canonical) or `name` (alias). Returns the trimmed string, or null.
 * P4b: the 422 for sending `name` was opaque, and Life HQ burned three rounds discovering it.
 * Aliasing costs nothing and the field is unambiguous — there is no other `name` on an exercise.
 */
/**
 * Prescribed per-exercise weight in lb. Accepts `target_weight_lb` OR `weight_lb`.
 *
 * ⚠️ WHY THE ALIAS EXISTS — this one drew blood. The 2026-07-28/07-30 deload routines were pushed with
 * `weight_lb`, which the composer did not read. `targetWeight` came back null, so every set fell
 * through to the progressive-overload default (last logged top weight) and the routines landed in
 * Hevy prescribing the EXACT loads the deload existed to back off from:
 *     Back Squat  135 intended → 185 pushed   (note read "Do NOT touch 185 again until Phase B")
 *     RDL          60 intended → 205 pushed
 *     Bench       135 intended → 155 pushed
 * A silently-ignored *name* costs a rejection round (P4b). A silently-ignored *weight* prescribes a
 * heavy session on a recovery week. Aliased rather than rejected because the safe failure here is
 * "the number the caller meant", not a 422.
 */
export function resolveTargetWeight(e: { target_weight_lb?: unknown; weight_lb?: unknown }): number | null {
  for (const v of [e.target_weight_lb, e.weight_lb]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export function resolveExerciseName(e: { gameplan_name?: unknown; name?: unknown } | null | undefined): string | null {
  if (!e || typeof e !== "object") return null;
  const raw = typeof e.gameplan_name === "string" && e.gameplan_name.trim() !== ""
    ? e.gameplan_name
    : typeof e.name === "string" && e.name.trim() !== ""
      ? e.name
      : null;
  return raw == null ? null : raw.trim();
}

export interface ComposeResult {
  ok: true;
  body: RoutineBody;
  title: string;
  intent: Intent;
  modifier_label: string;
  applied_caps: string[];
}

export interface ComposeSkip {
  ok: false;
  skipped: true;                                // gate = RED
  reason: string;
}

export interface ComposeError {
  ok: false;
  skipped: false;
  errors: ValidationError[];
}

export function composeRoutine(input: PushRoutineInput, folderId: number | null, lastWeights?: Map<string, { lb: number; reps: string }>): ComposeResult | ComposeSkip | ComposeError {
  const errors: ValidationError[] = [];
  // Resolved up front: the set-building step below needs it to suppress the progressive-overload
  // default on a deload, which happens before the title/notes step where intent is otherwise used.
  const intent = normalizeIntent(input.intent) ?? "full";

  // ── Step 1+2: resolve names → canonical → template_id, build InputExercise list
  // We expand compounds into multiple flat InputExercise rows here. Compound members inherit
  // the parent's weight/rest prescription (e.g. "Plank + Pallof Press" with rest_seconds=60
  // means both Plank and Pallof Press get 60s rest).
  type FlatEntry = InputExercise & {
    template_id: string;
    target_weight_lb: number | null;
    set_weights_lb: Array<number | null> | null;
    rest_seconds: number | null;
    per_side?: boolean;
  };
  const flat: FlatEntry[] = [];
  for (const e of input.exercises ?? []) {
    // `gameplan_name` is canonical; `name` is accepted as an alias (P4b — the undocumented
    // gameplan_name-vs-name distinction was returning bare 422s and costing rejection rounds).
    const rawName = resolveExerciseName(e);
    if (!rawName) {
      errors.push({ code: "bad_field", message: "exercise.gameplan_name (or name) required" });
      continue;
    }
    const canonicals = resolveGameplanName(rawName);
    if (canonicals.length === 0) {
      const hints = suggestFor(rawName);
      errors.push({
        code: "unknown_exercise",
        message: `no mapping for "${rawName}"${hints.length ? ` — did you mean: ${hints.join(", ")}?` : ""}`,
        field: rawName,
        suggestions: hints,
      });
      continue;
    }
    const targetWeight = resolveTargetWeight(e);
    const setWeights = Array.isArray(e.set_weights_lb)
      ? e.set_weights_lb.map((w) => (typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null))
      : null;
    const restSeconds = typeof e.rest_seconds === "number" && Number.isFinite(e.rest_seconds) && e.rest_seconds > 0
      ? Math.round(e.rest_seconds)
      : null;
    for (const c of canonicals) {
      const tid = templateIdFor(c);
      if (!tid) {
        errors.push({ code: "unknown_exercise", message: `no template_id for "${c}"`, field: c });
        continue;
      }
      flat.push({
        canonical_name: c,
        template_id: tid,
        sets: Math.max(1, Math.floor(Number(e.sets) || 1)),
        reps_raw: e.reps ?? null,
        rpe: e.rpe == null ? null : Number(e.rpe),
        note: e.note ?? null,
        target_weight_lb: targetWeight,
        set_weights_lb: setWeights,
        rest_seconds: restSeconds,
      });
    }
  }
  if (errors.length > 0) return { ok: false, skipped: false, errors };

  // ── Step 3: gate enforcement. Gate preserves order and our extra `template_id` field via spread.
  const gated = applyGate(input.gate, flat);
  if (gated.skip) {
    return { ok: false, skipped: true, reason: gated.modifier_label };
  }
  if (gated.exercises.length === 0) {
    return {
      ok: false, skipped: false,
      errors: [{ code: "no_exercises_after_gate", message: "no exercises remained after gate enforcement" }],
    };
  }

  // ── Steps 4-7: build Hevy exercises with N "normal" sets each.
  // Gate output keeps 1:1 order with `flat`, so we can pair by index — robust to duplicate
  // canonical names from compound expansion.
  //
  // Per-set weight resolution: set_weights_lb[i] ?? target_weight_lb. Both are in lb; convert to kg.
  // RPE goes into exercise notes (Hevy's API doesn't accept rpe on the routine-side set type).
  // rest_seconds attaches to the exercise (Hevy renders an inter-set countdown timer).
  //
  // Note on null fields: Hevy's POST tolerates nullable set fields, but PUT is stricter
  // ("rep_range must be of type object" if sent as null). We OMIT nullish fields entirely
  // so both verbs accept the same payload.
  const exercises: RoutineExercise[] = gated.exercises.map((ex, i) => {
    const fe = flat[i];
    const tid = fe.template_id;
    const parsed = parseReps(ex.reps_raw);
    const baseSet: RoutineSet = { type: "normal" };
    if (parsed.reps != null) baseSet.reps = parsed.reps;
    if (parsed.rep_range != null) baseSet.rep_range = parsed.rep_range;

    // Progressive-overload reference: when the payload doesn't set a weight, default the routine to
    // last week's same-exercise top working weight (the owner bumps from there) + surface it in the note.
    //
    // ⚠️ NEVER ON A DELOAD. Seeding last session's top weight is progressive overload — the exact
    // opposite of a deload's purpose. This default can put a full-weight squat into a routine
    // whose own note said not to touch that weight yet (the caller's weights had been
    // dropped for an unrelated reason — see resolveTargetWeight). Even with that bug fixed, an
    // unweighted exercise on a deload must come through BLANK for the owner to fill conservatively,
    // rather than pre-filled with the heaviest recent lift. This is a domain rule
    // enforced in the Worker, not upstream prompt discipline — per the actions-tier contract.
    const last = intent === "deload" ? null : (lastWeights?.get(tid) ?? null);
    const sets: RoutineSet[] = Array.from({ length: ex.sets }, (_, setIdx) => {
      const s: RoutineSet = { ...baseSet };
      const perSetLb = fe.set_weights_lb ? fe.set_weights_lb[setIdx] ?? null : null;
      const lb = perSetLb ?? fe.target_weight_lb ?? (last?.lb ?? null);
      const kg = lbToKg(lb);
      if (kg != null) s.weight_kg = kg;
      return s;
    });

    const rpeBit = ex.rpe != null ? `RPE ${ex.rpe}` : null;
    const perSideBit = parsed.per_side ? "per side" : null;
    const lastBit = last ? `last ${last.lb}lb (${last.reps})` : null;
    const noteParts = [ex.note, rpeBit, perSideBit, lastBit].filter((p): p is string => Boolean(p));

    const out: RoutineExercise = {
      exercise_template_id: tid,
      notes: sanitizeNotes(noteParts.join(" · ")),
      sets,
    };
    // Always attach a rest timer: explicit payload value, else a pattern-based default.
    out.rest_seconds = fe.rest_seconds ?? defaultRestSeconds(fe.canonical_name);
    return out;
  });

  // ── Step 7: title + routine notes
  //
  // P4a (2026-07-26): a caller-supplied `title` now WINS verbatim. Previously buildTitle() always
  // overwrote it, so a routine pushed as "…DELOAD Upper (60%)" landed in Hevy as "…Upper (GREEN)".
  // When no title is supplied we still generate one — and it now carries `intent`, so a deload is
  // visible in the Hevy list without the caller having to hand-write a title.
  const title = typeof input.title === "string" && input.title.trim() !== ""
    ? input.title.trim()
    : buildTitle(input.date, input.training_day, input.gate, intent);

  // Notes: the caller's rationale LEADS (it explains the session — "60% volume, deload week"), and
  // the machine-generated gate/caps line follows. The generated line is appended rather than
  // replaced because `applied_caps` is safety information: it records what the gate actually
  // stripped, and losing it would make an enforced cap invisible in the app.
  const generatedNote = [
    `Life HQ ${input.date} — ${input.training_day}`,
    intent !== "full" ? `Intent: ${INTENT_LABEL[intent]}` : null,
    `Gate: ${input.gate}${input.gate_modifier ? ` (${input.gate_modifier})` : ""}`,
    gated.applied_caps.length > 0 ? `Caps applied: ${gated.applied_caps.join("; ")}` : null,
  ].filter((p): p is string => Boolean(p)).join(" | ");

  const callerNote = typeof input.notes === "string" && input.notes.trim() !== "" ? input.notes.trim() : null;
  const headerNotes = [callerNote, generatedNote].filter((p): p is string => Boolean(p));

  const body: RoutineBody = {
    title,
    folder_id: folderId,
    notes: sanitizeNotes(headerNotes.join(" — ")) ?? "",
    exercises,
  };

  // modifier_label reports the GATE's effect ("GREEN — full plan"). On a deload that reads as a
  // contradiction, so prefix the intent when it isn't a plain full session — the response `note`
  // is what the caller echoes back into the card.
  const modifierLabel = intent === "full"
    ? gated.modifier_label
    : `${INTENT_LABEL[intent]} · ${gated.modifier_label}`;

  return { ok: true, body, title, intent, modifier_label: modifierLabel, applied_caps: gated.applied_caps };
}

const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Generated title, used only when the caller supplies none.
 * Shape: `Life HQ — {Dow} {M/D} {INTENT }{DayLabel} ({GATE})`
 * e.g.   `Life HQ — Tue 7/28 DELOAD Upper (GREEN)`
 * The gate word is retained (it's useful); intent sits alongside it rather than being displaced.
 */
export function buildTitle(date: string, trainingDay: string, gate: Gate, intent: Intent = "full"): string {
  // date = YYYY-MM-DD; we want "Tue 5/26"
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = SHORT_DAY[dt.getUTCDay()];
  // Strip leading "Day N " noise + parenthetical so the label reads cleanly.
  const dayLabel = trainingDay
    .replace(/^Day\s*\d+\s*/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim() || trainingDay;
  const intentBit = INTENT_LABEL[intent] ? `${INTENT_LABEL[intent]} ` : "";
  return `Life HQ — ${dow} ${m}/${d} ${intentBit}${dayLabel} (${gate})`;
}
