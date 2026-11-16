// Parse gameplan rep strings into Hevy set fields.
//
// Inputs we see in your own training plan:
//   "5"          → strength single number
//   "8"          → single number
//   "6-8"        → range
//   "10-12"      → range
//   "8-10 ea"    → range, "ea" = each side (informational; Hevy doesn't model per-side)
//   "3 sets ea"  → not a rep count; this is a timed/iso movement → no reps
//   "—" / "-"    → bodyweight / timed; no reps
//   ""           → no reps
//
// Hevy's PostRoutinesRequestSet has:
//   reps:       integer | null      (single target)
//   rep_range:  {start, end} | null (optional range; takes precedence if both present)
// We use rep_range for ranges and `reps` for single numbers. RPE is NOT a field on the set
// type — caller encodes it in the exercise notes.

export interface ParsedReps {
  reps: number | null;
  rep_range: { start: number; end: number } | null;
  per_side: boolean;
  timed: boolean;
}

const EM_DASH_RE = /^[—–\-]+$/;
const RANGE_RE   = /^\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*(ea|each|each side|per side)?\s*$/i;
const SINGLE_RE  = /^\s*(\d{1,3})\s*(ea|each|each side|per side)?\s*$/i;
const SETS_EA_RE = /sets?\s*(ea|each)/i;       // "3 sets ea" — caller already gave us sets

export function parseReps(input: unknown): ParsedReps {
  if (input == null) return EMPTY;
  const s = String(input).trim();
  if (s === "" || EM_DASH_RE.test(s) || SETS_EA_RE.test(s)) {
    return { reps: null, rep_range: null, per_side: false, timed: true };
  }
  const range = RANGE_RE.exec(s);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return {
      reps: null,
      rep_range: { start: Math.min(start, end), end: Math.max(start, end) },
      per_side: Boolean(range[3]),
      timed: false,
    };
  }
  const single = SINGLE_RE.exec(s);
  if (single) {
    return {
      reps: Number(single[1]),
      rep_range: null,
      per_side: Boolean(single[2]),
      timed: false,
    };
  }
  // Not parseable — treat as a notes-only / timed exercise.
  return { reps: null, rep_range: null, per_side: false, timed: true };
}

const EMPTY: ParsedReps = { reps: null, rep_range: null, per_side: false, timed: true };
