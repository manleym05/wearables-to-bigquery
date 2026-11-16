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

const TAIL_COLS = ["source", "raw_json", "ingested_at"];

export function activityMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "day", "external_id", "upload_id", "name", "type", "sport_type", "workout_type",
    "start_at", "start_at_local", "timezone", "utc_offset_s",
    "distance_m", "moving_time_s", "elapsed_time_s", "elevation_gain_m", "elev_high_m", "elev_low_m",
    "avg_speed_m_s", "max_speed_m_s", "avg_cadence", "avg_temp_c",
    "avg_hr_bpm", "max_hr_bpm", "has_heartrate",
    "avg_watts", "max_watts", "weighted_avg_watts", "device_watts", "kilojoules",
    "suffer_score", "calories",
    "start_lat", "start_lng", "end_lat", "end_lng",
    "gear_id", "device_name",
    "is_trainer", "is_commute", "is_manual", "is_private", "visibility",
    "pr_count", "achievement_count", "kudos_count", "comment_count", "athlete_count", "photo_count",
    "location_city", "location_state", "location_country", "summary_polyline",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_strava_activity"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id", "activity_id"]),
    keyCols: ["subject_id", "activity_id"],
    updateCols: cols,
    insertCols: ["subject_id", "activity_id", ...cols],
  });
}

export function athleteMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "athlete_id", "username", "firstname", "lastname",
    "city", "state", "country", "sex", "premium", "summit",
    "weight_kg", "ftp_watts", "measurement_preference",
    "created_at", "updated_at",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_strava_athlete"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id"]),
    keyCols: ["subject_id"],
    updateCols: cols,
    insertCols: ["subject_id", ...cols],
  });
}

export function zonesMergeSql(project: string, dataset: string, staging: string): string {
  const cols = [
    "hr_zones_json", "power_zones_json", "hr_zones_custom", "power_zones_custom",
    ...TAIL_COLS,
  ];
  return buildMerge({
    target: T(project, dataset, "raw_strava_zones"),
    source: dedupedSource(T(project, dataset, staging), ["subject_id"]),
    keyCols: ["subject_id"],
    updateCols: cols,
    insertCols: ["subject_id", ...cols],
  });
}
