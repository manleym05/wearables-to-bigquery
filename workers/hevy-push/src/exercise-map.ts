// Gameplan-exercise → Hevy template id mapping.
//
// Generated from `Cornerstone/configs/hevy-exercise-map.yaml` (the canonical source). When the
// YAML changes, regenerate this file by hand or via a small build step — the YAML is the SoT
// for human edits; this TS is what the Worker imports (CF Workers can't read FS at runtime).
//
// IDs come from Hevy's stock catalog in `life_ops.raw_hevy_exercise_template` (433 rows).

export const EXERCISE_MAP: Record<string, string> = {
  // Day 1: Upper (Hypertrophy)
  "Incline DB Press":            "07B38369",
  "Pull-up":                     "1B2B1E7C",
  "Pull-up (weighted)":          "729237D1",
  "Seated DB Shoulder Press":    "9930DF71",
  "Chest-supported Row":         "914F3A96",
  "Lateral Raise":               "422B08F1",
  "EZ-bar Curl":                 "01A35BF9",
  "Tricep Pushdown":             "93A552C6",

  // Day 2: Lower (Strength bias)
  "Front Squat":                 "5046D0A9",
  "Romanian Deadlift":           "2B4B7310",
  "Bulgarian Split Squat":       "B5D3A742",
  "Leg Curl":                    "B8127AD1",
  "Standing Calf Raise":         "06745E58",
  "Plank":                       "C6C9B8A0",
  "Pallof Press":                "CC55119B",

  // Day 3: Push
  "Flat Barbell Bench":          "79D0BB3A",
  "Incline DB Fly":              "D3E2AB55",
  "Cable Lateral Raise":         "BE289E45",
  "Overhead Tricep Extension":   "B5EFBF9C",
  "Tricep Rope Pushdown":        "94B7239B",

  // Day 4: Pull
  "Conventional Deadlift":       "C6272009",
  "Barbell Row":                 "55E6546F",
  "Single-Arm Cable Row":        "D0C4A899",
  "Rear Delt Fly":               "E5988A0A",
  "Hammer Curl":                 "7E3BC8B6",
  "Face Pull":                   "BE640BA0",

  // Day 5: Legs (Hypertrophy)
  "Back Squat":                  "D04AC939",
  "Hack Squat":                  "1E42FD5F",
  "Hip Thrust":                  "D57C2EC7",
  "Walking Lunge":               "A733CC5B",
  "Leg Extension":               "75A4F6C4",
  "Seated Leg Curl":             "11A123F3",
  "Seated Calf Raise":           "062AB91A",

  // Day 6: Full Body (light)
  "Trap Bar Deadlift":           "B923B230",
  "Goblet Squat":                "3D0C7C75",
  "DB Bench Press":              "3601968B",
  "One-Arm DB Row":              "F1E57334",
  "DB Overhead Press":           "6AC96645",
  "Side Plank":                  "E3EDA509",
};

// Aliases (resolved BEFORE compound expansion BEFORE primary lookup).
export const ALIASES: Record<string, string> = {
  "RDL":                                "Romanian Deadlift",
  "DB Row":                             "One-Arm DB Row",
  "DB Press":                           "DB Overhead Press",
  "DB Shoulder Press":                  "Seated DB Shoulder Press",
  "Goblet Squat (DB)":                  "Goblet Squat",
  "Bench Press":                        "Flat Barbell Bench",
  "Barbell Bench":                      "Flat Barbell Bench",
  "Pull-up (weighted if BW <8 RPE)":    "Pull-up",
  "Back Squat OR Hack Squat":           "Back Squat",
  "Trap Bar Deadlift OR Goblet Squat":  "Trap Bar Deadlift",
};

// Compound prescriptions (one gameplan line → N Hevy exercises with same set/rep prescription).
export const COMPOUNDS: Record<string, string[]> = {
  "Plank + Pallof Press":  ["Plank", "Pallof Press"],
  "Plank + Side Plank":    ["Plank", "Side Plank"],
};

/** Resolve a gameplan name to one or more canonical names. Empty array = unknown. */
export function resolveGameplanName(raw: string): string[] {
  const name = raw.trim();
  // 1. Compound (exact match preferred over alias)
  if (COMPOUNDS[name]) return COMPOUNDS[name].slice();
  // 2. Alias
  const aliased = ALIASES[name] ?? name;
  if (COMPOUNDS[aliased]) return COMPOUNDS[aliased].slice();
  // 3. Primary lookup (case-sensitive)
  if (EXERCISE_MAP[aliased]) return [aliased];
  // 4. Case-insensitive fallback
  const lower = aliased.toLowerCase();
  for (const k of Object.keys(EXERCISE_MAP)) {
    if (k.toLowerCase() === lower) return [k];
  }
  return [];
}

/** Returns the Hevy template id for a canonical name, or null if not found. */
export function templateIdFor(canonical: string): string | null {
  return EXERCISE_MAP[canonical] ?? null;
}

/**
 * Every name the Worker will accept, sorted. Returned in the 422 body so a caller that guessed a
 * name wrong can self-correct in ONE round instead of three (Life HQ passback 2026-07-26, P4b —
 * undocumented vocabulary cost three rejection rounds in a live Sunday session).
 */
export function acceptedVocabulary(): {
  canonical: string[];
  aliases: Record<string, string>;
  compounds: Record<string, string[]>;
} {
  return {
    canonical: Object.keys(EXERCISE_MAP).sort(),
    aliases: ALIASES,
    compounds: COMPOUNDS,
  };
}

/**
 * Best-effort "did you mean" for an unresolved name. Token-overlap scored (not edit distance) —
 * the real-world misses are wording drift ("Barbell Bench Press" vs "Flat Barbell Bench"), not typos.
 * Returns at most 3, only where overlap is meaningful.
 */
export function suggestFor(raw: string): string[] {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((t) => t.length > 1));
  const want = tokens(raw);
  if (want.size === 0) return [];

  const candidates = [...Object.keys(EXERCISE_MAP), ...Object.keys(ALIASES), ...Object.keys(COMPOUNDS)];
  return candidates
    .map((c) => {
      const have = tokens(c);
      let hits = 0;
      for (const t of want) if (have.has(t)) hits++;
      // Jaccard-ish: reward overlap, penalise candidates that are much longer than the query.
      return { name: c, score: hits / Math.max(want.size, have.size) };
    })
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.name);
}
