// MERGE staging -> target. Source-deduped via QUALIFY (latest ingested_at wins per natural key).

const T = (project: string, dataset: string, name: string) => `\`${project}.${dataset}.${name}\``;

function dedupedSource(table: string, partitionCols: string[]): string {
  const parts = partitionCols.join(", ");
  return `(
    SELECT * FROM ${table}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ${parts} ORDER BY ingested_at DESC) = 1
  )`;
}

function buildMerge(opts: {
  target: string;
  source: string;
  keyCols: string[];           // natural key columns (in MERGE ON)
  updateCols: string[];        // columns to UPDATE on match
  insertCols: string[];        // full insert column list
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

const TAIL_COLS = ["source", "raw_json", "ingested_at"];

export function measureMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "measured_at", "day",
    "weight_kg", "height_m", "fat_free_mass_kg", "fat_ratio_pct", "fat_mass_kg",
    "muscle_mass_kg", "hydration_kg", "bone_mass_kg",
    "bp_diastolic_mmhg", "bp_systolic_mmhg", "heart_pulse_bpm",
    "spo2_pct", "body_temp_c", "skin_temp_c",
    "pulse_wave_velocity_m_s", "vo2_max", "vascular_age_years",
    "afib_result", "nerve_health",
    "attrib", "category", "device_id",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_measure"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "grpid"]),
    keyCols: ["subject_id", "grpid"],
    updateCols: cols,
    insertCols: ["subject_id", "grpid", ...cols],
  });
}

export function sleepMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "day", "startdate", "enddate",
    "total_sleep_h", "asleep_h", "deep_sleep_h", "light_sleep_h", "rem_sleep_h", "awake_h", "time_in_bed_h",
    "sleep_efficiency_pct", "sleep_score", "withings_index",
    "sleep_latency_min", "wakeup_latency_min", "wakeup_count", "waso_min",
    "nb_rem_episodes", "out_of_bed_count",
    "hr_avg_bpm", "hr_min_bpm", "hr_max_bpm",
    "hrv_avg_ms", "hrv_lowest_ms",
    "rr_avg", "rr_min", "rr_max",
    "breathing_disturbances_intensity", "snoring_episode_count", "snoring_s", "apnea_hypopnea_index",
    "timezone", "model", "model_id", "device_id_hash",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_sleep"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "sleep_id"]),
    keyCols: ["subject_id", "sleep_id"],
    updateCols: cols,
    insertCols: ["subject_id", "sleep_id", ...cols],
  });
}

export function activityMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "timezone", "device_id_hash", "is_tracker",
    "steps", "distance_m", "elevation_m",
    "soft_s", "moderate_s", "intense_s", "active_s",
    "calories", "total_calories",
    "hr_avg_bpm", "hr_min_bpm", "hr_max_bpm",
    "hr_zone_0_s", "hr_zone_1_s", "hr_zone_2_s", "hr_zone_3_s",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_activity"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "day"]),
    keyCols: ["subject_id", "day"],
    updateCols: cols,
    insertCols: ["subject_id", "day", ...cols],
  });
}

export function workoutMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "day", "category", "attrib", "startdate", "enddate",
    "effective_duration_s", "pause_duration_s", "algo_pause_duration_s",
    "intensity", "calories", "manual_calories",
    "steps", "distance_m", "manual_distance_m", "elevation_m", "ascent_m", "descent_m",
    "spo2_avg_pct",
    "hr_avg_bpm", "hr_min_bpm", "hr_max_bpm",
    "hr_zone_0_s", "hr_zone_1_s", "hr_zone_2_s", "hr_zone_3_s",
    "device_id", "model", "model_id", "timezone",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_workout"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "workout_id"]),
    keyCols: ["subject_id", "workout_id"],
    updateCols: cols,
    insertCols: ["subject_id", "workout_id", ...cols],
  });
}

export function heartMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "measured_at", "day",
    "heart_rate_bpm", "ecg_signal_id", "afib_classification",
    "bp_systolic_mmhg", "bp_diastolic_mmhg",
    "device_id", "model", "timezone",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_heart"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "measurement_id"]),
    keyCols: ["subject_id", "measurement_id"],
    updateCols: cols,
    insertCols: ["subject_id", "measurement_id", ...cols],
  });
}

export function deviceMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "type", "model", "model_id", "battery", "timezone",
    "first_session_at", "last_session_at",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_withings_device"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "device_id_hash"]),
    keyCols: ["subject_id", "device_id_hash"],
    updateCols: cols,
    insertCols: ["subject_id", "device_id_hash", ...cols],
  });
}
