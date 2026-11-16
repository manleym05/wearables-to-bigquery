// HRV gate → routine modifier.
//
// Truth table (from your own training plan autoregulation rules + the
// hevy-push spec):
//
//   GREEN   → full plan, RPE per template (no Worker change)
//   YELLOW  → strength compounds capped at RPE 7; full accessories; no top sets removed
//   AMBER   → drop the LAST set of each strength compound (≈ –30% volume on heavy
//             movements); accessories cap RPE 7; no top sets
//   RED     → skip — the Worker does NOT push; agent renders a rest-day card instead
//
// "Strength compound" detection: any exercise whose name contains squat / deadlift / bench /
// press / row / pull-up / pull up / clean / hip thrust as its primary movement. Conservative
// list — we'd rather over-trim than not enforce the safety layer on AMBER.

export type Gate = "GREEN" | "YELLOW" | "AMBER" | "RED";

const STRENGTH_COMPOUND_RE =
  /\b(squat|deadlift|bench|press|row|pull[- ]?up|clean|hip\s*thrust|thruster)\b/i;

/** Heuristic — is this a heavy compound that gates should treat as "strength"? */
export function isStrengthCompound(canonicalName: string): boolean {
  // Exclude pure accessories that share words (e.g., "Tricep Pushdown" has "press" no, "Push down" yes — actually "pushdown" isn't "press"). Tweak only if we see false positives.
  if (/lateral raise|face pull|leg curl|leg extension|calf raise|fly|rear delt/i.test(canonicalName)) return false;
  return STRENGTH_COMPOUND_RE.test(canonicalName);
}

export interface InputExercise {
  canonical_name: string;
  sets: number;
  reps_raw: string | null;
  rpe: number | null;
  note: string | null;
}

export interface GateResult {
  skip: boolean;                  // true when gate is RED
  modifier_label: string;         // human-readable summary for the routine notes
  exercises: InputExercise[];     // exercises after gate adjustment
  applied_caps: string[];         // per-exercise list of "what we did", for the audit log
}

const RPE_CAP_YELLOW = 7;
const RPE_CAP_AMBER  = 7;

export function applyGate(gate: Gate, exercises: InputExercise[]): GateResult {
  if (gate === "RED") {
    return {
      skip: true,
      modifier_label: "RED — rest day; no routine pushed",
      exercises: [],
      applied_caps: [],
    };
  }

  if (gate === "GREEN") {
    return {
      skip: false,
      modifier_label: "GREEN — full plan",
      exercises: exercises.map((e) => ({ ...e })),
      applied_caps: [],
    };
  }

  const applied: string[] = [];
  const out: InputExercise[] = exercises.map((ex) => {
    const isStrength = isStrengthCompound(ex.canonical_name);
    let { sets, rpe, note } = ex;

    if (gate === "YELLOW") {
      if (isStrength && (rpe == null || rpe > RPE_CAP_YELLOW)) {
        const noteSuffix = rpe == null ? "RPE cap 7 (YELLOW)" : `RPE cap 7 (was ${rpe}) (YELLOW)`;
        applied.push(`${ex.canonical_name}: ${noteSuffix}`);
        note = note ? `${note} | ${noteSuffix}` : noteSuffix;
        rpe = RPE_CAP_YELLOW;
      }
    } else if (gate === "AMBER") {
      // -30% volume on strength compounds = drop last set; otherwise cap RPE 7 on everything.
      if (isStrength && sets > 1) {
        const dropped = sets - Math.max(1, sets - 1);
        sets = sets - 1;
        const noteSuffix = `set −${dropped} & RPE cap 7 (AMBER)`;
        applied.push(`${ex.canonical_name}: ${noteSuffix}`);
        note = note ? `${note} | ${noteSuffix}` : noteSuffix;
        rpe = RPE_CAP_AMBER;
      } else if (rpe == null || rpe > RPE_CAP_AMBER) {
        const noteSuffix = rpe == null ? "RPE cap 7 (AMBER)" : `RPE cap 7 (was ${rpe}) (AMBER)`;
        applied.push(`${ex.canonical_name}: ${noteSuffix}`);
        note = note ? `${note} | ${noteSuffix}` : noteSuffix;
        rpe = RPE_CAP_AMBER;
      }
    }

    return { ...ex, sets, rpe, note };
  });

  return {
    skip: false,
    modifier_label:
      gate === "YELLOW"
        ? `YELLOW — RPE 7 cap on strength compounds (${applied.length} adjusted)`
        : `AMBER — vol −30% & RPE 7 cap (${applied.length} adjusted)`,
    exercises: out,
    applied_caps: applied,
  };
}
