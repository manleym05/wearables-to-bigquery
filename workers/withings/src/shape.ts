// Withings payloads -> staging row shapes.
// Measure groups carry many measures pivoted by type. shape.ts decodes value*10^unit
// and pivots into typed columns.

import type {
  MeasureGroup, SleepSummarySeries, Activity, Workout, HeartSeries, Device,
} from "./withings";

const SEC_TO_MIN = (s: number | null | undefined): number | null =>
  s == null ? null : +(s / 60).toFixed(2);
const SEC_TO_HOUR = (s: number | null | undefined): number | null =>
  s == null ? null : +(s / 3600).toFixed(4);

// Withings measure values: real = value × 10^unit
function decode(value: number, unit: number): number {
  return value * Math.pow(10, unit);
}

// Convert epoch seconds (UTC) → ISO 8601 UTC timestamp string.
function epochToIso(s: number | null | undefined): string | null {
  return s == null ? null : new Date(s * 1000).toISOString();
}

// Convert epoch + timezone into YYYY-MM-DD in that timezone. Fallback to UTC date.
function epochToDay(s: number | null | undefined, tz: string): string | null {
  if (s == null) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s * 1000));
  } catch {
    return new Date(s * 1000).toISOString().slice(0, 10);
  }
}

// Meastype map. Keys = Withings meastype codes.
const MEASTYPE = {
  WEIGHT_KG: 1,
  HEIGHT_M: 4,
  FAT_FREE_MASS_KG: 5,
  FAT_RATIO_PCT: 6,
  FAT_MASS_KG: 8,
  BP_DIASTOLIC: 9,
  BP_SYSTOLIC: 10,
  HEART_PULSE_BPM: 11,
  TEMP_C: 12,
  SPO2_PCT: 54,
  BODY_TEMP_C: 71,
  SKIN_TEMP_C: 73,
  MUSCLE_MASS_KG: 76,
  HYDRATION_KG: 77,
  BONE_MASS_KG: 88,
  PULSE_WAVE_VELOCITY: 91,
  VO2_MAX: 123,
  AFIB_RESULT: 155,
  VASCULAR_AGE: 167,
  NERVE_HEALTH: 168,
} as const;

// ---------- raw_withings_measure ----------

export interface MeasureRow {
  subject_id: number;
  grpid: number;
  measured_at: string;
  day: string;
  weight_kg: number | null;
  height_m: number | null;
  fat_free_mass_kg: number | null;
  fat_ratio_pct: number | null;
  fat_mass_kg: number | null;
  muscle_mass_kg: number | null;
  hydration_kg: number | null;
  bone_mass_kg: number | null;
  bp_diastolic_mmhg: number | null;
  bp_systolic_mmhg: number | null;
  heart_pulse_bpm: number | null;
  spo2_pct: number | null;
  body_temp_c: number | null;
  skin_temp_c: number | null;
  pulse_wave_velocity_m_s: number | null;
  vo2_max: number | null;
  vascular_age_years: number | null;
  afib_result: number | null;
  nerve_health: number | null;
  attrib: number | null;
  category: number | null;
  device_id: string | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildMeasureRows(subjectId: number, groups: MeasureGroup[], tz: string, ingestedAt: string): MeasureRow[] {
  return groups.map((g) => {
    const m: Record<number, number> = {};
    for (const v of g.measures) m[v.type] = decode(v.value, v.unit);
    return {
      subject_id: subjectId,
      grpid: g.grpid,
      measured_at: epochToIso(g.date)!,
      day: epochToDay(g.date, tz)!,
      weight_kg: m[MEASTYPE.WEIGHT_KG] ?? null,
      height_m: m[MEASTYPE.HEIGHT_M] ?? null,
      fat_free_mass_kg: m[MEASTYPE.FAT_FREE_MASS_KG] ?? null,
      fat_ratio_pct: m[MEASTYPE.FAT_RATIO_PCT] ?? null,
      fat_mass_kg: m[MEASTYPE.FAT_MASS_KG] ?? null,
      muscle_mass_kg: m[MEASTYPE.MUSCLE_MASS_KG] ?? null,
      hydration_kg: m[MEASTYPE.HYDRATION_KG] ?? null,
      bone_mass_kg: m[MEASTYPE.BONE_MASS_KG] ?? null,
      bp_diastolic_mmhg: m[MEASTYPE.BP_DIASTOLIC] ?? null,
      bp_systolic_mmhg: m[MEASTYPE.BP_SYSTOLIC] ?? null,
      heart_pulse_bpm: m[MEASTYPE.HEART_PULSE_BPM] ?? null,
      spo2_pct: m[MEASTYPE.SPO2_PCT] ?? null,
      body_temp_c: m[MEASTYPE.BODY_TEMP_C] ?? m[MEASTYPE.TEMP_C] ?? null,
      skin_temp_c: m[MEASTYPE.SKIN_TEMP_C] ?? null,
      pulse_wave_velocity_m_s: m[MEASTYPE.PULSE_WAVE_VELOCITY] ?? null,
      vo2_max: m[MEASTYPE.VO2_MAX] ?? null,
      vascular_age_years: m[MEASTYPE.VASCULAR_AGE] ?? null,
      afib_result: m[MEASTYPE.AFIB_RESULT] != null ? Math.round(m[MEASTYPE.AFIB_RESULT]) : null,
      nerve_health: m[MEASTYPE.NERVE_HEALTH] ?? null,
      attrib: g.attrib ?? null,
      category: g.category ?? null,
      device_id: g.deviceid ?? g.hash_deviceid ?? null,
      source: "withings_api",
      raw_json: JSON.stringify(g),
      ingested_at: ingestedAt,
    };
  });
}

// ---------- raw_withings_sleep ----------

export interface SleepRow {
  subject_id: number;
  sleep_id: string;
  day: string;
  startdate: string | null;
  enddate: string | null;
  total_sleep_h: number | null;
  asleep_h: number | null;
  deep_sleep_h: number | null;
  light_sleep_h: number | null;
  rem_sleep_h: number | null;
  awake_h: number | null;
  time_in_bed_h: number | null;
  sleep_efficiency_pct: number | null;
  sleep_score: number | null;
  withings_index: number | null;
  sleep_latency_min: number | null;
  wakeup_latency_min: number | null;
  wakeup_count: number | null;
  waso_min: number | null;
  nb_rem_episodes: number | null;
  out_of_bed_count: number | null;
  hr_avg_bpm: number | null;
  hr_min_bpm: number | null;
  hr_max_bpm: number | null;
  hrv_avg_ms: number | null;
  hrv_lowest_ms: number | null;
  rr_avg: number | null;
  rr_min: number | null;
  rr_max: number | null;
  breathing_disturbances_intensity: number | null;
  snoring_episode_count: number | null;
  snoring_s: number | null;
  apnea_hypopnea_index: number | null;
  timezone: string | null;
  model: string | null;
  model_id: number | null;
  device_id_hash: string | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildSleepRows(subjectId: number, series: SleepSummarySeries[], ingestedAt: string): SleepRow[] {
  return series.map((s) => {
    const d = s.data ?? {};
    return {
      subject_id: subjectId,
      sleep_id: s.id != null ? String(s.id) : `${s.startdate}-${s.hash_deviceid ?? "x"}`,
      day: s.date,
      startdate: epochToIso(s.startdate),
      enddate: epochToIso(s.enddate),
      total_sleep_h: SEC_TO_HOUR(d.total_sleep_time),
      asleep_h: SEC_TO_HOUR(d.asleepduration),
      deep_sleep_h: SEC_TO_HOUR(d.deepsleepduration),
      light_sleep_h: SEC_TO_HOUR(d.lightsleepduration),
      rem_sleep_h: SEC_TO_HOUR(d.remsleepduration),
      awake_h: SEC_TO_HOUR(d.wakeupduration),
      time_in_bed_h: SEC_TO_HOUR(d.total_timeinbed),
      sleep_efficiency_pct: d.sleep_efficiency != null ? +(d.sleep_efficiency * 100).toFixed(2) : null,
      sleep_score: d.sleep_score ?? null,
      withings_index: d.withings_index ?? null,
      sleep_latency_min: SEC_TO_MIN(d.sleep_latency ?? d.durationtosleep),
      wakeup_latency_min: SEC_TO_MIN(d.wakeup_latency ?? d.durationtowakeup),
      wakeup_count: d.wakeupcount ?? null,
      waso_min: SEC_TO_MIN(d.waso),
      nb_rem_episodes: d.nb_rem_episodes ?? null,
      out_of_bed_count: d.out_of_bed_count ?? null,
      hr_avg_bpm: d.hr_average ?? null,
      hr_min_bpm: d.hr_min ?? null,
      hr_max_bpm: d.hr_max ?? null,
      hrv_avg_ms: d.hrv_average ?? null,
      hrv_lowest_ms: d.hrv_lowest ?? null,
      rr_avg: d.rr_average ?? null,
      rr_min: d.rr_min ?? null,
      rr_max: d.rr_max ?? null,
      breathing_disturbances_intensity: d.breathing_disturbances_intensity ?? null,
      snoring_episode_count: d.snoringepisodecount ?? null,
      snoring_s: d.snoring ?? null,
      apnea_hypopnea_index: d.apnea_hypopnea_index ?? null,
      timezone: s.timezone ?? null,
      model: s.model ?? null,
      model_id: s.model_id ?? null,
      device_id_hash: s.hash_deviceid ?? null,
      source: "withings_api",
      raw_json: JSON.stringify(s),
      ingested_at: ingestedAt,
    };
  });
}

// ---------- raw_withings_activity ----------

export interface ActivityRow {
  subject_id: number;
  day: string;
  timezone: string | null;
  device_id_hash: string | null;
  is_tracker: boolean | null;
  steps: number | null;
  distance_m: number | null;
  elevation_m: number | null;
  soft_s: number | null;
  moderate_s: number | null;
  intense_s: number | null;
  active_s: number | null;
  calories: number | null;
  total_calories: number | null;
  hr_avg_bpm: number | null;
  hr_min_bpm: number | null;
  hr_max_bpm: number | null;
  hr_zone_0_s: number | null;
  hr_zone_1_s: number | null;
  hr_zone_2_s: number | null;
  hr_zone_3_s: number | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildActivityRows(subjectId: number, items: Activity[], ingestedAt: string): ActivityRow[] {
  return items.map((a) => ({
    subject_id: subjectId,
    day: a.date,
    timezone: a.timezone ?? null,
    device_id_hash: a.hash_deviceid ?? null,
    is_tracker: a.is_tracker ?? null,
    steps: a.steps ?? null,
    distance_m: a.distance ?? null,
    elevation_m: a.elevation ?? null,
    soft_s: a.soft ?? null,
    moderate_s: a.moderate ?? null,
    intense_s: a.intense ?? null,
    active_s: a.active ?? null,
    calories: a.calories ?? null,
    total_calories: a.totalcalories ?? null,
    hr_avg_bpm: a.hr_average ?? null,
    hr_min_bpm: a.hr_min ?? null,
    hr_max_bpm: a.hr_max ?? null,
    hr_zone_0_s: a.hr_zone_0 ?? null,
    hr_zone_1_s: a.hr_zone_1 ?? null,
    hr_zone_2_s: a.hr_zone_2 ?? null,
    hr_zone_3_s: a.hr_zone_3 ?? null,
    source: "withings_api",
    raw_json: JSON.stringify(a),
    ingested_at: ingestedAt,
  }));
}

// ---------- raw_withings_workout ----------

export interface WorkoutRow {
  subject_id: number;
  workout_id: number;
  day: string;
  category: number | null;
  attrib: number | null;
  startdate: string | null;
  enddate: string | null;
  effective_duration_s: number | null;
  pause_duration_s: number | null;
  algo_pause_duration_s: number | null;
  intensity: number | null;
  calories: number | null;
  manual_calories: number | null;
  steps: number | null;
  distance_m: number | null;
  manual_distance_m: number | null;
  elevation_m: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  spo2_avg_pct: number | null;
  hr_avg_bpm: number | null;
  hr_min_bpm: number | null;
  hr_max_bpm: number | null;
  hr_zone_0_s: number | null;
  hr_zone_1_s: number | null;
  hr_zone_2_s: number | null;
  hr_zone_3_s: number | null;
  device_id: string | null;
  model: number | null;
  model_id: number | null;
  timezone: string | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildWorkoutRows(subjectId: number, items: Workout[], ingestedAt: string): WorkoutRow[] {
  return items.map((w) => {
    const d = w.data ?? {};
    return {
      subject_id: subjectId,
      workout_id: w.id ?? w.startdate,  // fallback synthesizes id from startdate
      day: w.date,
      category: w.category ?? null,
      attrib: w.attrib ?? null,
      startdate: epochToIso(w.startdate),
      enddate: epochToIso(w.enddate),
      effective_duration_s: d.effduration ?? null,
      pause_duration_s: d.pause_duration ?? null,
      algo_pause_duration_s: d.algo_pause_duration ?? null,
      intensity: d.intensity ?? null,
      calories: d.calories ?? null,
      manual_calories: d.manual_calories ?? null,
      steps: d.steps ?? null,
      distance_m: d.distance ?? null,
      manual_distance_m: d.manual_distance ?? null,
      elevation_m: d.elevation ?? null,
      ascent_m: d.ascent ?? null,
      descent_m: d.descent ?? null,
      spo2_avg_pct: d.spo2_average ?? null,
      hr_avg_bpm: d.hr_average ?? null,
      hr_min_bpm: d.hr_min ?? null,
      hr_max_bpm: d.hr_max ?? null,
      hr_zone_0_s: d.hr_zone_0 ?? null,
      hr_zone_1_s: d.hr_zone_1 ?? null,
      hr_zone_2_s: d.hr_zone_2 ?? null,
      hr_zone_3_s: d.hr_zone_3 ?? null,
      device_id: w.deviceid ?? null,
      model: w.model ?? null,
      model_id: w.model_id ?? null,
      timezone: w.timezone ?? null,
      source: "withings_api",
      raw_json: JSON.stringify(w),
      ingested_at: ingestedAt,
    };
  });
}

// ---------- raw_withings_heart ----------

export interface HeartRow {
  subject_id: number;
  measurement_id: string;
  measured_at: string;
  day: string;
  heart_rate_bpm: number | null;
  ecg_signal_id: number | null;
  afib_classification: number | null;
  bp_systolic_mmhg: number | null;
  bp_diastolic_mmhg: number | null;
  device_id: string | null;
  model: number | null;
  timezone: string | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildHeartRows(subjectId: number, items: HeartSeries[], tz: string, ingestedAt: string): HeartRow[] {
  return items.map((h) => ({
    subject_id: subjectId,
    measurement_id: `${h.deviceid ?? "x"}-${h.timestamp}`,
    measured_at: epochToIso(h.timestamp)!,
    day: epochToDay(h.timestamp, h.timezone ?? tz)!,
    heart_rate_bpm: h.heart_rate ?? null,
    ecg_signal_id: h.ecg?.signalid ?? null,
    afib_classification: h.ecg?.afib ?? null,
    bp_systolic_mmhg: h.bloodpressure?.systole ?? null,
    bp_diastolic_mmhg: h.bloodpressure?.diastole ?? null,
    device_id: h.deviceid ?? null,
    model: h.model ?? null,
    timezone: h.timezone ?? null,
    source: "withings_api",
    raw_json: JSON.stringify(h),
    ingested_at: ingestedAt,
  }));
}

// ---------- raw_withings_device ----------

export interface DeviceRow {
  subject_id: number;
  device_id_hash: string;
  type: string | null;
  model: string | null;
  model_id: number | null;
  battery: string | null;
  timezone: string | null;
  first_session_at: string | null;
  last_session_at: string | null;
  source: "withings_api";
  raw_json: string;
  ingested_at: string;
}

export function buildDeviceRows(subjectId: number, items: Device[], ingestedAt: string): DeviceRow[] {
  return items
    .filter((d) => d.hash_deviceid || d.deviceid)
    .map((d) => ({
      subject_id: subjectId,
      device_id_hash: d.hash_deviceid ?? d.deviceid!,
      type: d.type ?? null,
      model: d.model ?? null,
      model_id: d.model_id ?? null,
      battery: d.battery ?? null,
      timezone: d.timezone ?? null,
      first_session_at: epochToIso(d.first_session_date),
      last_session_at: epochToIso(d.last_session_date),
      source: "withings_api",
      raw_json: JSON.stringify(d),
      ingested_at: ingestedAt,
    }));
}
