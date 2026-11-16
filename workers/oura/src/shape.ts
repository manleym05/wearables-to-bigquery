// Endpoint payloads -> staging row shapes.
// raw_oura_daily: one row per wake-date, merging /daily_sleep + /daily_readiness +
//                 /daily_activity + day-level rollup from /sleep (HRV/RHR/phase durations).
// raw_oura_sleep: one row per /sleep session.
// All other tables: one row per Oura record (or singleton for personal_info).

import type {
  DailySleep, DailyReadiness, DailyActivity, SleepSession,
  DailyStress, DailySpo2, DailyResilience, DailyCardioAge,
  Vo2Max, Workout, Session, EnhancedTag, RestModePeriod, SleepTime,
  PersonalInfo, RingConfiguration, Heartrate, RingBatteryLevel,
} from "./oura";

const sToH = (s: number | null | undefined): number | null => (s == null ? null : +(s / 3600).toFixed(4));
const sToMin = (s: number | null | undefined): number | null => (s == null ? null : Math.round(s / 60));
const sToMinF = (s: number | null | undefined): number | null => (s == null ? null : +(s / 60).toFixed(2));

// ---------- raw_oura_daily ----------

export interface DailyRow {
  subject_id: number;
  day: string;
  rhr_low_bpm: number | null;
  rhr_avg_bpm: number | null;
  hrv_avg_ms: number | null;
  sleep_total_h: number | null;
  sleep_deep_h: number | null;
  sleep_rem_h: number | null;
  sleep_light_h: number | null;
  sleep_efficiency_pct: number | null;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  steps: number | null;
  respiratory_rate: number | null;
  body_temp_dev_c: number | null;
  // enrichment columns (added 2026-05-20)
  active_calories: number | null;
  total_calories: number | null;
  avg_met_minutes: number | null;
  sedentary_min: number | null;
  non_wear_min: number | null;
  resting_time_min: number | null;
  high_activity_min: number | null;
  medium_activity_min: number | null;
  low_activity_min: number | null;
  equivalent_walking_m: number | null;
  temperature_trend_dev_c: number | null;
  sleep_contributors_json: string | null;
  readiness_contributors_json: string | null;
  activity_contributors_json: string | null;
  // standard tail
  source: "oura_api";
  source_id: string | null;
  raw_json: string;
  ingested_at: string;
}

// Oura sleep `type` values: long_sleep | sleep | late_nap | nap | rest | deleted.
// "Main" = a real overnight sleep; everything else is a nap/short rest that must NEVER be
// treated as the night (its HRV/RHR are daytime values that would corrupt the daily row).
const MAIN_SLEEP_TYPES = new Set(["long_sleep", "sleep"]);

// Resolve the local (TZ) calendar date for an ISO timestamp; fall back to `fallback` if unparseable.
function localDateInTz(iso: string | null | undefined, tz: string, fallback: string): string {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return fallback;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(t));
}

// Re-key non-main sessions to the actual local date they occurred. Oura assigns an evening nap
// to the *upcoming* wake-date (e.g. a 2026-05-24 19:45 late_nap is returned with day=2026-05-25),
// which mis-attributes it. Main sleeps keep Oura's wake-date convention (intentional — see arch
// doc + 02_raw_oura_sleep.sql). MERGE key is (subject_id, sleep_id), so re-keying just updates
// the row's `day` in place (BigQuery moves it to the correct date partition).
export function correctSleepDays(sleeps: SleepSession[], tz: string): SleepSession[] {
  return sleeps.map((s) => {
    if (MAIN_SLEEP_TYPES.has(s.type ?? "")) return s;
    const corrected = localDateInTz(s.bedtime_end ?? s.bedtime_start ?? null, tz, s.day);
    return corrected === s.day ? s : { ...s, day: corrected };
  });
}

function pickMainSleepByDay(sleeps: SleepSession[]): Map<string, SleepSession> {
  const byDay = new Map<string, SleepSession[]>();
  for (const s of sleeps) {
    if (!s.day) continue;
    const arr = byDay.get(s.day) ?? [];
    arr.push(s);
    byDay.set(s.day, arr);
  }
  const out = new Map<string, SleepSession>();
  for (const [day, arr] of byDay) {
    const longs = arr.filter((s) => s.type === "long_sleep");
    // Only consider real overnight sleeps. If a day has none (e.g. only a late_nap, or the main
    // session hasn't finalized yet), emit NO main sleep — the daily row's HRV/RHR/sleep_* stay
    // null ("pending") rather than inheriting a daytime nap's values.
    const mains = longs.length > 0 ? longs : arr.filter((s) => MAIN_SLEEP_TYPES.has(s.type ?? ""));
    if (mains.length === 0) continue;
    const choose = mains.reduce((best, cur) =>
      (cur.total_sleep_duration ?? 0) > (best.total_sleep_duration ?? 0) ? cur : best,
    );
    out.set(day, choose);
  }
  return out;
}

export function buildDailyRows(
  subjectId: number,
  sleepScores: DailySleep[],
  readiness: DailyReadiness[],
  activity: DailyActivity[],
  sleeps: SleepSession[],
  ingestedAt: string,
): DailyRow[] {
  const days = new Set<string>();
  for (const x of sleepScores) days.add(x.day);
  for (const x of readiness) days.add(x.day);
  for (const x of activity) days.add(x.day);
  for (const x of sleeps) days.add(x.day);

  const sleepScoreByDay = new Map(sleepScores.map((x) => [x.day, x]));
  const readinessByDay = new Map(readiness.map((x) => [x.day, x]));
  const activityByDay = new Map(activity.map((x) => [x.day, x]));
  const mainSleepByDay = pickMainSleepByDay(sleeps);

  const out: DailyRow[] = [];
  for (const day of days) {
    const ss = sleepScoreByDay.get(day);
    const rd = readinessByDay.get(day);
    const ac = activityByDay.get(day);
    const sl = mainSleepByDay.get(day);

    out.push({
      subject_id: subjectId,
      day,
      rhr_low_bpm: sl?.lowest_heart_rate ?? null,
      rhr_avg_bpm: sl?.average_heart_rate ?? null,
      hrv_avg_ms: sl?.average_hrv ?? null,
      sleep_total_h: sToH(sl?.total_sleep_duration),
      sleep_deep_h: sToH(sl?.deep_sleep_duration),
      sleep_rem_h: sToH(sl?.rem_sleep_duration),
      sleep_light_h: sToH(sl?.light_sleep_duration),
      sleep_efficiency_pct: sl?.efficiency ?? null,
      sleep_score: ss?.score ?? null,
      readiness_score: rd?.score ?? null,
      activity_score: ac?.score ?? null,
      steps: ac?.steps ?? null,
      respiratory_rate: sl?.average_breath ?? null,
      body_temp_dev_c: rd?.temperature_deviation ?? null,
      active_calories: ac?.active_calories ?? null,
      total_calories: ac?.total_calories ?? null,
      avg_met_minutes: ac?.average_met_minutes ?? null,
      sedentary_min: sToMin(ac?.sedentary_time),
      non_wear_min: sToMin(ac?.non_wear_time),
      resting_time_min: sToMin(ac?.resting_time),
      high_activity_min: sToMin(ac?.high_activity_time),
      medium_activity_min: sToMin(ac?.medium_activity_time),
      low_activity_min: sToMin(ac?.low_activity_time),
      equivalent_walking_m: ac?.equivalent_walking_distance ?? null,
      temperature_trend_dev_c: rd?.temperature_trend_deviation ?? null,
      sleep_contributors_json: ss?.contributors ? JSON.stringify(ss.contributors) : null,
      readiness_contributors_json: rd?.contributors ? JSON.stringify(rd.contributors) : null,
      activity_contributors_json: ac?.contributors ? JSON.stringify(ac.contributors) : null,
      source: "oura_api",
      source_id: ss?.id ?? rd?.id ?? ac?.id ?? sl?.id ?? null,
      raw_json: JSON.stringify({
        daily_sleep: ss ?? null,
        daily_readiness: rd ?? null,
        daily_activity: ac ?? null,
        sleep_main: sl ?? null,
      }),
      ingested_at: ingestedAt,
    });
  }
  return out;
}

// ---------- raw_oura_sleep ----------

export interface SleepRow {
  subject_id: number;
  day: string;
  sleep_id: string;
  type: string | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  total_sleep_h: number | null;
  time_in_bed_h: number | null;
  deep_sleep_h: number | null;
  rem_sleep_h: number | null;
  light_sleep_h: number | null;
  awake_h: number | null;
  efficiency_pct: number | null;
  latency_min: number | null;
  avg_hrv_ms: number | null;
  hr_lowest_bpm: number | null;
  hr_avg_bpm: number | null;
  avg_breath_rate: number | null;
  restless_periods: number | null;
  readiness_score: number | null;
  source: "oura_api";
  raw_json: string;
  ingested_at: string;
}

export function buildSleepRows(subjectId: number, sleeps: SleepSession[], ingestedAt: string): SleepRow[] {
  return sleeps.map((s) => ({
    subject_id: subjectId,
    day: s.day,
    sleep_id: s.id,
    type: s.type ?? null,
    bedtime_start: s.bedtime_start ?? null,
    bedtime_end: s.bedtime_end ?? null,
    total_sleep_h: sToH(s.total_sleep_duration),
    time_in_bed_h: sToH(s.time_in_bed),
    deep_sleep_h: sToH(s.deep_sleep_duration),
    rem_sleep_h: sToH(s.rem_sleep_duration),
    light_sleep_h: sToH(s.light_sleep_duration),
    awake_h: sToH(s.awake_time),
    efficiency_pct: s.efficiency ?? null,
    latency_min: sToMinF(s.latency),
    avg_hrv_ms: s.average_hrv ?? null,
    hr_lowest_bpm: s.lowest_heart_rate ?? null,
    hr_avg_bpm: s.average_heart_rate ?? null,
    avg_breath_rate: s.average_breath ?? null,
    restless_periods: s.restless_periods ?? null,
    readiness_score: s.readiness?.score ?? null,
    source: "oura_api",
    raw_json: JSON.stringify(s),
    ingested_at: ingestedAt,
  }));
}

// ---------- new tables ----------

const std = (subjectId: number, ingestedAt: string) => ({
  subject_id: subjectId,
  source: "oura_api" as const,
  ingested_at: ingestedAt,
});

export interface DailyStressRow {
  subject_id: number; day: string;
  stress_high_s: number | null; recovery_high_s: number | null; day_summary: string | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildDailyStressRows(subjectId: number, rows: DailyStress[], ingestedAt: string): DailyStressRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    stress_high_s: r.stress_high ?? null,
    recovery_high_s: r.recovery_high ?? null,
    day_summary: r.day_summary ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface DailySpo2Row {
  subject_id: number; day: string;
  spo2_avg_pct: number | null; breathing_disturbance_index: number | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildDailySpo2Rows(subjectId: number, rows: DailySpo2[], ingestedAt: string): DailySpo2Row[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    spo2_avg_pct: r.spo2_percentage?.average ?? null,
    breathing_disturbance_index: r.breathing_disturbance_index ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface DailyResilienceRow {
  subject_id: number; day: string;
  level: string | null;
  sleep_recovery: number | null; daytime_recovery: number | null; stress_contributor: number | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildDailyResilienceRows(subjectId: number, rows: DailyResilience[], ingestedAt: string): DailyResilienceRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    level: r.level ?? null,
    sleep_recovery: r.contributors?.sleep_recovery ?? null,
    daytime_recovery: r.contributors?.daytime_recovery ?? null,
    stress_contributor: r.contributors?.stress ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface DailyCardioAgeRow {
  subject_id: number; day: string;
  vascular_age_years: number | null; pulse_wave_velocity: number | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildDailyCardioAgeRows(subjectId: number, rows: DailyCardioAge[], ingestedAt: string): DailyCardioAgeRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    vascular_age_years: r.vascular_age ?? null,
    pulse_wave_velocity: r.pulse_wave_velocity ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface Vo2MaxRow {
  subject_id: number; day: string;
  measured_at: string | null; vo2_max: number | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildVo2MaxRows(subjectId: number, rows: Vo2Max[], ingestedAt: string): Vo2MaxRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    measured_at: r.timestamp ?? null,
    vo2_max: r.vo2_max ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface WorkoutRow {
  subject_id: number; day: string; workout_id: string;
  activity: string | null; intensity: string | null;
  start_datetime: string | null; end_datetime: string | null;
  calories: number | null; distance_m: number | null;
  label: string | null; oura_source: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildWorkoutRows(subjectId: number, rows: Workout[], ingestedAt: string): WorkoutRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    workout_id: r.id,
    activity: r.activity ?? null,
    intensity: r.intensity ?? null,
    start_datetime: r.start_datetime ?? null,
    end_datetime: r.end_datetime ?? null,
    calories: r.calories ?? null,
    distance_m: r.distance ?? null,
    label: r.label ?? null,
    oura_source: r.source ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface SessionRow {
  subject_id: number; day: string; session_id: string;
  type: string | null; mood: string | null;
  start_datetime: string | null; end_datetime: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildSessionRows(subjectId: number, rows: Session[], ingestedAt: string): SessionRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    session_id: r.id,
    type: r.type ?? null,
    mood: r.mood ?? null,
    start_datetime: r.start_datetime ?? null,
    end_datetime: r.end_datetime ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface EnhancedTagRow {
  subject_id: number; start_day: string; tag_id: string;
  tag_type_code: string | null; custom_name: string | null; comment: string | null;
  start_time: string | null; end_time: string | null; end_day: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildEnhancedTagRows(subjectId: number, rows: EnhancedTag[], ingestedAt: string): EnhancedTagRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    start_day: r.start_day,
    tag_id: r.id,
    tag_type_code: r.tag_type_code ?? null,
    custom_name: r.custom_name ?? null,
    comment: r.comment ?? null,
    start_time: r.start_time ?? null,
    end_time: r.end_time ?? null,
    end_day: r.end_day ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface RestModePeriodRow {
  subject_id: number; start_day: string; period_id: string;
  end_day: string | null; start_time: string | null; end_time: string | null;
  episodes_json: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildRestModePeriodRows(subjectId: number, rows: RestModePeriod[], ingestedAt: string): RestModePeriodRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    start_day: r.start_day,
    period_id: r.id,
    end_day: r.end_day ?? null,
    start_time: r.start_time ?? null,
    end_time: r.end_time ?? null,
    episodes_json: r.episodes ? JSON.stringify(r.episodes) : null,
    raw_json: JSON.stringify(r),
  }));
}

export interface SleepTimeRow {
  subject_id: number; day: string;
  optimal_bedtime_json: string | null; recommendation: string | null; status: string | null;
  source: "oura_api"; source_id: string | null; raw_json: string; ingested_at: string;
}
export function buildSleepTimeRows(subjectId: number, rows: SleepTime[], ingestedAt: string): SleepTimeRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    day: r.day,
    optimal_bedtime_json: r.optimal_bedtime ? JSON.stringify(r.optimal_bedtime) : null,
    recommendation: r.recommendation ?? null,
    status: r.status ?? null,
    source_id: r.id ?? null,
    raw_json: JSON.stringify(r),
  }));
}

export interface PersonalInfoRow {
  subject_id: number; oura_user_id: string | null;
  age: number | null; weight_kg: number | null; height_m: number | null;
  biological_sex: string | null; email: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildPersonalInfoRow(subjectId: number, p: PersonalInfo, ingestedAt: string): PersonalInfoRow {
  return {
    ...std(subjectId, ingestedAt),
    oura_user_id: p.id ?? null,
    age: p.age ?? null,
    weight_kg: p.weight ?? null,
    height_m: p.height ?? null,
    biological_sex: p.biological_sex ?? null,
    email: p.email ?? null,
    raw_json: JSON.stringify(p),
  };
}

export interface RingConfigRow {
  subject_id: number; ring_id: string;
  color: string | null; design: string | null;
  hardware_type: string | null; firmware_version: string | null;
  size: number | null; set_up_at: string | null;
  source: "oura_api"; raw_json: string; ingested_at: string;
}
export function buildRingConfigRows(subjectId: number, rows: RingConfiguration[], ingestedAt: string): RingConfigRow[] {
  return rows.map((r) => ({
    ...std(subjectId, ingestedAt),
    ring_id: r.id,
    color: r.color ?? null,
    design: r.design ?? null,
    hardware_type: r.hardware_type ?? null,
    firmware_version: r.firmware_version ?? null,
    size: r.size ?? null,
    set_up_at: r.set_up_at ?? null,
    raw_json: JSON.stringify(r),
  }));
}

// ---------- raw_oura_heartrate (one row per sample) ----------
// NOTE: `source` is the 'oura' provenance literal per the spec — NOT the "oura_api" the `std()` helper
// emits — so this builder is written out explicitly. `hr_source` carries Oura's per-sample context
// enum. `day` is intentionally absent (computed as DATE(ts,'America/New_York') in the MERGE), and so is
// `raw_json`: {bpm,source,timestamp} are fully captured by the typed columns, so the target's raw_json
// column is left SQL NULL (a high-volume table — the blob would just double storage for no fidelity gain).

export interface HeartrateRow {
  subject_id: number;
  ts: string;
  bpm: number | null;
  hr_source: string | null;
  source: "oura";
  ingested_at: string;
}
export function buildHeartrateRows(subjectId: number, samples: Heartrate[], ingestedAt: string): HeartrateRow[] {
  return samples.map((s) => ({
    subject_id: subjectId,
    ts: s.timestamp,
    bpm: s.bpm ?? null,
    hr_source: s.source ?? null,
    source: "oura",
    ingested_at: ingestedAt,
  }));
}

// ---------- raw_oura_ring_battery_level (one row per sample) ----------
// Same per-sample shape as heartrate: `day` computed in the MERGE, no raw_json (the typed
// columns fully capture {timestamp,level,charging,in_charger}; timestamp_unix is redundant
// with ts and intentionally dropped). `source` = 'oura' provenance literal, matching heartrate.

export interface RingBatteryRow {
  subject_id: number;
  ts: string;
  level: number | null;
  charging: boolean | null;
  in_charger: boolean | null;
  source: "oura";
  ingested_at: string;
}
export function buildRingBatteryRows(subjectId: number, samples: RingBatteryLevel[], ingestedAt: string): RingBatteryRow[] {
  return samples.map((s) => ({
    subject_id: subjectId,
    ts: s.timestamp,
    level: s.level ?? null,
    charging: s.charging ?? null,
    in_charger: s.in_charger ?? null,
    source: "oura",
    ingested_at: ingestedAt,
  }));
}
