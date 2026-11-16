// MERGE staging -> target with QUALIFY source-dedup.

const T = (project: string, dataset: string, name: string) => `\`${project}.${dataset}.${name}\``;

function dedupedSource(table: string, partitionCols: string[]): string {
  const parts = partitionCols.join(", ");
  return `(
    SELECT * FROM ${table}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ${parts} ORDER BY ingested_at DESC) = 1
  )`;
}

function buildMerge(opts: {
  target: string; source: string; keyCols: string[];
  updateCols: string[]; insertCols: string[];
}): string {
  const { target, source, keyCols, updateCols, insertCols } = opts;
  const on = keyCols.map((c) => `U.${c} = S.${c}`).join(" AND ");
  const setClause = updateCols.map((c) => `${c} = S.${c}`).join(", ");
  const insertList = insertCols.join(", ");
  const valuesList = insertCols.map((c) => `S.${c}`).join(", ");
  return `
MERGE ${target} U USING ${source} S
ON ${on}
WHEN MATCHED THEN UPDATE SET ${setClause}
WHEN NOT MATCHED THEN INSERT (${insertList}) VALUES (${valuesList})`.trim();
}

const TAIL = ["source", "raw_json", "ingested_at"];

export function workoutMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "day", "title", "description", "start_at", "end_at", "duration_min",
    "exercise_count", "set_count", "total_volume_kg", "total_volume_lb",
    "total_reps", "avg_rpe", "created_at", "updated_at",
    ...TAIL,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_hevy_workout"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "workout_id"]),
    keyCols: ["subject_id", "workout_id"],
    updateCols: cols,
    insertCols: ["subject_id", "workout_id", ...cols],
  });
}

export function setMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "day", "exercise_template_id", "exercise_title", "exercise_notes", "supersets_id",
    "set_type", "weight_kg", "weight_lb", "reps", "distance_m", "duration_s", "rpe",
    "custom_metric", "volume_kg",
    ...TAIL,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_hevy_set"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "workout_id", "exercise_idx", "set_idx"]),
    keyCols: ["subject_id", "workout_id", "exercise_idx", "set_idx"],
    updateCols: cols,
    insertCols: ["subject_id", "workout_id", "exercise_idx", "set_idx", ...cols],
  });
}

export function exerciseTemplateMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "title", "type", "primary_muscle_group", "secondary_muscle_groups_json",
    "equipment", "is_custom",
    ...TAIL,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_hevy_exercise_template"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "exercise_template_id"]),
    keyCols: ["subject_id", "exercise_template_id"],
    updateCols: cols,
    insertCols: ["subject_id", "exercise_template_id", ...cols],
  });
}
