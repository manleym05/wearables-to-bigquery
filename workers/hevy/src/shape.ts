// Hevy payloads -> staging row shapes.
// Workouts pivot to two tables: one row per workout, one row per (workout, exercise, set).

import type { Workout, ExerciseTemplate } from "./hevy";

const dayInTz = (iso: string | undefined, tz: string): string | null => {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
};

const KG_TO_LB = (kg: number | null | undefined): number | null =>
  kg == null ? null : +(kg * 2.20462).toFixed(2);

// ---------- raw_hevy_workout ----------

export interface WorkoutRow {
  subject_id: number;
  workout_id: string;
  day: string;
  title: string | null;
  description: string | null;
  start_at: string;
  end_at: string | null;
  duration_min: number | null;
  exercise_count: number;
  set_count: number;
  total_volume_kg: number | null;
  total_volume_lb: number | null;
  total_reps: number | null;
  avg_rpe: number | null;
  created_at: string | null;
  updated_at: string | null;
  source: "hevy_api";
  raw_json: string;
  ingested_at: string;
}

function summarizeWorkout(w: Workout): { setCount: number; totalReps: number; totalVolumeKg: number; rpes: number[] } {
  let setCount = 0, totalReps = 0, totalVolumeKg = 0;
  const rpes: number[] = [];
  for (const ex of w.exercises ?? []) {
    for (const s of ex.sets ?? []) {
      if (s.type === "warmup") continue;       // warmups don't count toward volume
      setCount++;
      if (s.reps != null) totalReps += s.reps;
      if (s.weight_kg != null && s.reps != null) totalVolumeKg += s.weight_kg * s.reps;
      if (s.rpe != null) rpes.push(s.rpe);
    }
  }
  return { setCount, totalReps, totalVolumeKg, rpes };
}

export function buildWorkoutRows(subjectId: number, workouts: Workout[], tz: string, ingestedAt: string): WorkoutRow[] {
  return workouts.map((w) => {
    const summary = summarizeWorkout(w);
    const startMs = Date.parse(w.start_time);
    const endMs = w.end_time ? Date.parse(w.end_time) : NaN;
    const durationMin = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 60000) : null;
    const avgRpe = summary.rpes.length > 0
      ? +(summary.rpes.reduce((a, b) => a + b, 0) / summary.rpes.length).toFixed(2)
      : null;
    return {
      subject_id: subjectId,
      workout_id: w.id,
      day: dayInTz(w.start_time, tz) ?? "1970-01-01",
      title: w.title ?? null,
      description: w.description ?? null,
      start_at: w.start_time,
      end_at: w.end_time ?? null,
      duration_min: durationMin,
      exercise_count: (w.exercises ?? []).length,
      set_count: summary.setCount,
      total_volume_kg: summary.totalVolumeKg > 0 ? +summary.totalVolumeKg.toFixed(2) : null,
      total_volume_lb: summary.totalVolumeKg > 0 ? KG_TO_LB(summary.totalVolumeKg) : null,
      total_reps: summary.totalReps > 0 ? summary.totalReps : null,
      avg_rpe: avgRpe,
      created_at: w.created_at ?? null,
      updated_at: w.updated_at ?? null,
      source: "hevy_api",
      raw_json: JSON.stringify(w),
      ingested_at: ingestedAt,
    };
  });
}

// ---------- raw_hevy_set ----------

export interface SetRow {
  subject_id: number;
  workout_id: string;
  exercise_idx: number;
  set_idx: number;
  day: string;
  exercise_template_id: string;
  exercise_title: string | null;
  exercise_notes: string | null;
  supersets_id: number | null;
  set_type: string | null;
  weight_kg: number | null;
  weight_lb: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  rpe: number | null;
  custom_metric: number | null;
  volume_kg: number | null;
  source: "hevy_api";
  raw_json: string;
  ingested_at: string;
}

export function buildSetRows(subjectId: number, workouts: Workout[], tz: string, ingestedAt: string): SetRow[] {
  const out: SetRow[] = [];
  for (const w of workouts) {
    const day = dayInTz(w.start_time, tz) ?? "1970-01-01";
    for (const ex of w.exercises ?? []) {
      for (const s of ex.sets ?? []) {
        const volumeKg = s.weight_kg != null && s.reps != null ? +(s.weight_kg * s.reps).toFixed(2) : null;
        out.push({
          subject_id: subjectId,
          workout_id: w.id,
          exercise_idx: ex.index ?? 0,
          set_idx: s.index ?? 0,
          day,
          exercise_template_id: ex.exercise_template_id,
          exercise_title: ex.title ?? null,
          exercise_notes: ex.notes ?? null,
          supersets_id: ex.supersets_id ?? null,
          set_type: s.type ?? null,
          weight_kg: s.weight_kg ?? null,
          weight_lb: KG_TO_LB(s.weight_kg),
          reps: s.reps ?? null,
          distance_m: s.distance_meters ?? null,
          duration_s: s.duration_seconds ?? null,
          rpe: s.rpe ?? null,
          custom_metric: s.custom_metric ?? null,
          volume_kg: volumeKg,
          source: "hevy_api",
          raw_json: JSON.stringify({ exercise: { index: ex.index, title: ex.title, exercise_template_id: ex.exercise_template_id }, set: s }),
          ingested_at: ingestedAt,
        });
      }
    }
  }
  return out;
}

// ---------- raw_hevy_exercise_template ----------

export interface ExerciseTemplateRow {
  subject_id: number;
  exercise_template_id: string;
  title: string | null;
  type: string | null;
  primary_muscle_group: string | null;
  secondary_muscle_groups_json: string | null;
  equipment: string | null;
  is_custom: boolean | null;
  source: "hevy_api";
  raw_json: string;
  ingested_at: string;
}

export function buildExerciseTemplateRows(subjectId: number, items: ExerciseTemplate[], ingestedAt: string): ExerciseTemplateRow[] {
  return items.map((t) => ({
    subject_id: subjectId,
    exercise_template_id: t.id,
    title: t.title ?? null,
    type: t.type ?? null,
    primary_muscle_group: t.primary_muscle_group ?? null,
    secondary_muscle_groups_json: t.secondary_muscle_groups ? JSON.stringify(t.secondary_muscle_groups) : null,
    equipment: t.equipment ?? null,
    is_custom: t.is_custom ?? null,
    source: "hevy_api",
    raw_json: JSON.stringify(t),
    ingested_at: ingestedAt,
  }));
}
