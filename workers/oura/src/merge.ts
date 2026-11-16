// MERGE staging -> target. Target schemas exist; staging tables are created by the
// load job (CREATE_IF_NEEDED) with matching schemas. Each MERGE source-dedupes via
// QUALIFY so concurrent loads / duplicate source rows cannot cause double-inserts.

const T = (project: string, dataset: string, name: string) => `\`${project}.${dataset}.${name}\``;

// QUALIFY-deduped source: keep one row per natural key (latest ingested_at wins).
function dedupedSource(table: string, partitionCols: string[]): string {
  const parts = partitionCols.join(", ");
  return `(
    SELECT * FROM ${table}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ${parts} ORDER BY ingested_at DESC) = 1
  )`;
}

export function dailyMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_daily");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "day"]);
  return `
MERGE ${target} U
USING ${src} S
ON U.subject_id = S.subject_id AND U.day = S.day
WHEN MATCHED THEN UPDATE SET
  rhr_low_bpm = S.rhr_low_bpm, rhr_avg_bpm = S.rhr_avg_bpm, hrv_avg_ms = S.hrv_avg_ms,
  sleep_total_h = S.sleep_total_h, sleep_deep_h = S.sleep_deep_h, sleep_rem_h = S.sleep_rem_h,
  sleep_light_h = S.sleep_light_h, sleep_efficiency_pct = S.sleep_efficiency_pct,
  sleep_score = S.sleep_score, readiness_score = S.readiness_score,
  activity_score = S.activity_score, steps = S.steps,
  respiratory_rate = S.respiratory_rate, body_temp_dev_c = S.body_temp_dev_c,
  active_calories = S.active_calories, total_calories = S.total_calories,
  avg_met_minutes = S.avg_met_minutes,
  sedentary_min = S.sedentary_min, non_wear_min = S.non_wear_min, resting_time_min = S.resting_time_min,
  high_activity_min = S.high_activity_min, medium_activity_min = S.medium_activity_min, low_activity_min = S.low_activity_min,
  equivalent_walking_m = S.equivalent_walking_m, temperature_trend_dev_c = S.temperature_trend_dev_c,
  sleep_contributors_json = S.sleep_contributors_json,
  readiness_contributors_json = S.readiness_contributors_json,
  activity_contributors_json = S.activity_contributors_json,
  source = S.source, source_id = S.source_id, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, rhr_low_bpm, rhr_avg_bpm, hrv_avg_ms,
  sleep_total_h, sleep_deep_h, sleep_rem_h, sleep_light_h, sleep_efficiency_pct,
  sleep_score, readiness_score, activity_score, steps,
  respiratory_rate, body_temp_dev_c,
  active_calories, total_calories, avg_met_minutes,
  sedentary_min, non_wear_min, resting_time_min,
  high_activity_min, medium_activity_min, low_activity_min,
  equivalent_walking_m, temperature_trend_dev_c,
  sleep_contributors_json, readiness_contributors_json, activity_contributors_json,
  source, source_id, raw_json, ingested_at
) VALUES (
  S.subject_id, S.day, S.rhr_low_bpm, S.rhr_avg_bpm, S.hrv_avg_ms,
  S.sleep_total_h, S.sleep_deep_h, S.sleep_rem_h, S.sleep_light_h, S.sleep_efficiency_pct,
  S.sleep_score, S.readiness_score, S.activity_score, S.steps,
  S.respiratory_rate, S.body_temp_dev_c,
  S.active_calories, S.total_calories, S.avg_met_minutes,
  S.sedentary_min, S.non_wear_min, S.resting_time_min,
  S.high_activity_min, S.medium_activity_min, S.low_activity_min,
  S.equivalent_walking_m, S.temperature_trend_dev_c,
  S.sleep_contributors_json, S.readiness_contributors_json, S.activity_contributors_json,
  S.source, S.source_id, S.raw_json, S.ingested_at
)`.trim();
}

export function sleepMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_sleep");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "sleep_id"]);
  return `
MERGE ${target} U
USING ${src} S
ON U.subject_id = S.subject_id AND U.sleep_id = S.sleep_id
WHEN MATCHED THEN UPDATE SET
  day = S.day, type = S.type, bedtime_start = S.bedtime_start, bedtime_end = S.bedtime_end,
  total_sleep_h = S.total_sleep_h, time_in_bed_h = S.time_in_bed_h,
  deep_sleep_h = S.deep_sleep_h, rem_sleep_h = S.rem_sleep_h,
  light_sleep_h = S.light_sleep_h, awake_h = S.awake_h,
  efficiency_pct = S.efficiency_pct, latency_min = S.latency_min,
  avg_hrv_ms = S.avg_hrv_ms, hr_lowest_bpm = S.hr_lowest_bpm, hr_avg_bpm = S.hr_avg_bpm,
  avg_breath_rate = S.avg_breath_rate, restless_periods = S.restless_periods,
  readiness_score = S.readiness_score,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, sleep_id, type, bedtime_start, bedtime_end,
  total_sleep_h, time_in_bed_h, deep_sleep_h, rem_sleep_h, light_sleep_h, awake_h,
  efficiency_pct, latency_min, avg_hrv_ms, hr_lowest_bpm, hr_avg_bpm,
  avg_breath_rate, restless_periods, readiness_score,
  source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.day, S.sleep_id, S.type, S.bedtime_start, S.bedtime_end,
  S.total_sleep_h, S.time_in_bed_h, S.deep_sleep_h, S.rem_sleep_h, S.light_sleep_h, S.awake_h,
  S.efficiency_pct, S.latency_min, S.avg_hrv_ms, S.hr_lowest_bpm, S.hr_avg_bpm,
  S.avg_breath_rate, S.restless_periods, S.readiness_score,
  S.source, S.raw_json, S.ingested_at
)`.trim();
}

// ---------- simple MERGE generator for (subject_id, day)-keyed daily-rollup tables ----------

function dailyScalarMerge(
  project: string, dataset: string, targetTable: string, stagingTable: string, cols: string[],
): string {
  const target = T(project, dataset, targetTable);
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "day"]);
  const setClause = cols.map((c) => `${c} = S.${c}`).join(", ");
  const allCols = ["subject_id", "day", ...cols, "source", "source_id", "raw_json", "ingested_at"];
  const insertList = allCols.join(", ");
  const valuesList = allCols.map((c) => `S.${c}`).join(", ");
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.day = S.day
WHEN MATCHED THEN UPDATE SET
  ${setClause},
  source = S.source, source_id = S.source_id, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (${insertList}) VALUES (${valuesList})`.trim();
}

export function dailyStressMergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_daily_stress", st, ["stress_high_s", "recovery_high_s", "day_summary"]);
}
export function dailySpo2MergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_daily_spo2", st, ["spo2_avg_pct", "breathing_disturbance_index"]);
}
export function dailyResilienceMergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_daily_resilience", st, ["level", "sleep_recovery", "daytime_recovery", "stress_contributor"]);
}
export function dailyCardioAgeMergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_daily_cardio_age", st, ["vascular_age_years", "pulse_wave_velocity"]);
}
export function vo2MaxMergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_vo2_max", st, ["measured_at", "vo2_max"]);
}
export function sleepTimeMergeSql(project: string, dataset: string, st: string): string {
  return dailyScalarMerge(project, dataset, "raw_oura_sleep_time", st, ["optimal_bedtime_json", "recommendation", "status"]);
}

// ---------- event-keyed tables (id-based natural key) ----------

export function workoutMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_workout");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "workout_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.workout_id = S.workout_id
WHEN MATCHED THEN UPDATE SET
  day = S.day, activity = S.activity, intensity = S.intensity,
  start_datetime = S.start_datetime, end_datetime = S.end_datetime,
  calories = S.calories, distance_m = S.distance_m, label = S.label,
  oura_source = S.oura_source,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, workout_id, activity, intensity,
  start_datetime, end_datetime, calories, distance_m, label, oura_source,
  source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.day, S.workout_id, S.activity, S.intensity,
  S.start_datetime, S.end_datetime, S.calories, S.distance_m, S.label, S.oura_source,
  S.source, S.raw_json, S.ingested_at
)`.trim();
}

export function sessionMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_session");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "session_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.session_id = S.session_id
WHEN MATCHED THEN UPDATE SET
  day = S.day, type = S.type, mood = S.mood,
  start_datetime = S.start_datetime, end_datetime = S.end_datetime,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, session_id, type, mood, start_datetime, end_datetime,
  source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.day, S.session_id, S.type, S.mood, S.start_datetime, S.end_datetime,
  S.source, S.raw_json, S.ingested_at
)`.trim();
}

export function enhancedTagMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_enhanced_tag");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "tag_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.tag_id = S.tag_id
WHEN MATCHED THEN UPDATE SET
  start_day = S.start_day, tag_type_code = S.tag_type_code,
  custom_name = S.custom_name, comment = S.comment,
  start_time = S.start_time, end_time = S.end_time, end_day = S.end_day,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, start_day, tag_id, tag_type_code, custom_name, comment,
  start_time, end_time, end_day, source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.start_day, S.tag_id, S.tag_type_code, S.custom_name, S.comment,
  S.start_time, S.end_time, S.end_day, S.source, S.raw_json, S.ingested_at
)`.trim();
}

export function restModeMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_rest_mode_period");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "period_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.period_id = S.period_id
WHEN MATCHED THEN UPDATE SET
  start_day = S.start_day, end_day = S.end_day,
  start_time = S.start_time, end_time = S.end_time,
  episodes_json = S.episodes_json,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, start_day, period_id, end_day, start_time, end_time,
  episodes_json, source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.start_day, S.period_id, S.end_day, S.start_time, S.end_time,
  S.episodes_json, S.source, S.raw_json, S.ingested_at
)`.trim();
}

// ---------- intraday heart rate (sample-grain, (subject_id, ts) key) ----------
// `day` is NOT in staging — it's derived here as DATE(ts, tz) in the INSERT (one source of truth: ts).
// `tz` is injected from env (a wrangler var, not user input) → no injection surface, and the emitted
// SQL literal stays 'America/New_York', matching the partition-key contract in the DDL.
// `raw_json` is deliberately absent from both clauses: the target column is left at its SQL-NULL default
// on INSERT and untouched on UPDATE (loading a JSON `null` would store a JSON-null literal, not SQL NULL).
export function heartrateMergeSql(project: string, dataset: string, stagingTable: string, tz: string): string {
  const target = T(project, dataset, "raw_oura_heartrate");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "ts"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.ts = S.ts
WHEN MATCHED THEN UPDATE SET
  bpm = S.bpm, hr_source = S.hr_source, source = S.source, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, ts, bpm, hr_source, source, ingested_at
) VALUES (
  S.subject_id, DATE(S.ts, '${tz}'), S.ts, S.bpm, S.hr_source, S.source, S.ingested_at
)`.trim();
}

export function ringBatteryMergeSql(project: string, dataset: string, stagingTable: string, tz: string): string {
  const target = T(project, dataset, "raw_oura_ring_battery_level");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "ts"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.ts = S.ts
WHEN MATCHED THEN UPDATE SET
  level = S.level, charging = S.charging, in_charger = S.in_charger,
  source = S.source, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, day, ts, level, charging, in_charger, source, ingested_at
) VALUES (
  S.subject_id, DATE(S.ts, '${tz}'), S.ts, S.level, S.charging, S.in_charger, S.source, S.ingested_at
)`.trim();
}

export function personalInfoMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_personal_info");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id
WHEN MATCHED THEN UPDATE SET
  oura_user_id = S.oura_user_id, age = S.age, weight_kg = S.weight_kg, height_m = S.height_m,
  biological_sex = S.biological_sex, email = S.email,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, oura_user_id, age, weight_kg, height_m, biological_sex, email,
  source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.oura_user_id, S.age, S.weight_kg, S.height_m, S.biological_sex, S.email,
  S.source, S.raw_json, S.ingested_at
)`.trim();
}

export function ringConfigMergeSql(project: string, dataset: string, stagingTable: string): string {
  const target = T(project, dataset, "raw_oura_ring_config");
  const src = dedupedSource(T(project, dataset, stagingTable), ["subject_id", "ring_id"]);
  return `
MERGE ${target} U USING ${src} S
ON U.subject_id = S.subject_id AND U.ring_id = S.ring_id
WHEN MATCHED THEN UPDATE SET
  color = S.color, design = S.design, hardware_type = S.hardware_type,
  firmware_version = S.firmware_version, size = S.size, set_up_at = S.set_up_at,
  source = S.source, raw_json = S.raw_json, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT (
  subject_id, ring_id, color, design, hardware_type, firmware_version, size, set_up_at,
  source, raw_json, ingested_at
) VALUES (
  S.subject_id, S.ring_id, S.color, S.design, S.hardware_type, S.firmware_version, S.size, S.set_up_at,
  S.source, S.raw_json, S.ingested_at
)`.trim();
}
