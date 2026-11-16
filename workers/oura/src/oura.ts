// Oura v2 API client. `token` is any valid bearer token — an OAuth access token
// (normal path, see oauth.ts) or the legacy PAT during the migration window.
// All endpoints paginate via next_token; both daily- and event-style endpoints accept
// (start_date, end_date) as ISO YYYY-MM-DD. personal_info is a singleton (no pagination).

const BASE = "https://api.ouraring.com/v2/usercollection";

// ---------- existing 4 endpoints (extended with contributors / extras) ----------

export interface SleepContributors {
  deep_sleep?: number;
  efficiency?: number;
  latency?: number;
  rem_sleep?: number;
  restfulness?: number;
  timing?: number;
  total_sleep?: number;
}

export interface DailySleep {
  id: string;
  day: string;
  score?: number | null;
  contributors?: SleepContributors;
  timestamp?: string;
}

export interface ReadinessContributors {
  activity_balance?: number;
  body_temperature?: number;
  hrv_balance?: number;
  previous_day_activity?: number;
  previous_night?: number;
  recovery_index?: number;
  resting_heart_rate?: number;
  sleep_balance?: number;
  sleep_regularity?: number;
}

export interface DailyReadiness {
  id: string;
  day: string;
  score?: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
  contributors?: ReadinessContributors;
  timestamp?: string;
}

export interface ActivityContributors {
  meet_daily_targets?: number;
  move_every_hour?: number;
  recovery_time?: number;
  stay_active?: number;
  training_frequency?: number;
  training_volume?: number;
}

export interface DailyActivity {
  id: string;
  day: string;
  score?: number | null;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  average_met_minutes?: number | null;
  // all *_time fields are SECONDS
  sedentary_time?: number | null;
  non_wear_time?: number | null;
  resting_time?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  low_activity_time?: number | null;
  equivalent_walking_distance?: number | null; // meters
  contributors?: ActivityContributors;
}

export interface SleepSession {
  id: string;
  day: string;
  type?: string;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number;
  time_in_bed?: number;
  deep_sleep_duration?: number;
  rem_sleep_duration?: number;
  light_sleep_duration?: number;
  awake_time?: number;
  efficiency?: number;
  latency?: number;
  average_hrv?: number | null;
  lowest_heart_rate?: number | null;
  average_heart_rate?: number | null;
  average_breath?: number | null;
  restless_periods?: number | null;
  readiness?: { score?: number | null } | null;
}

// ---------- new daily-score endpoints ----------

export interface DailyStress {
  id: string;
  day: string;
  stress_high?: number | null;     // seconds
  recovery_high?: number | null;   // seconds
  day_summary?: string | null;
}

export interface DailySpo2 {
  id: string;
  day: string;
  spo2_percentage?: { average?: number | null } | null;
  breathing_disturbance_index?: number | null;
}

export interface ResilienceContributors {
  sleep_recovery?: number;
  daytime_recovery?: number;
  stress?: number;
}

export interface DailyResilience {
  id: string;
  day: string;
  level?: string | null;
  contributors?: ResilienceContributors;
}

export interface DailyCardioAge {
  id: string;
  day: string;
  vascular_age?: number | null;
  pulse_wave_velocity?: number | null;
}

// ---------- new event/session endpoints ----------

export interface Vo2Max {
  id: string;
  day: string;
  timestamp?: string;
  vo2_max?: number | null;
}

export interface Workout {
  id: string;
  day: string;
  activity?: string;
  intensity?: string;
  start_datetime?: string;
  end_datetime?: string;
  calories?: number | null;
  distance?: number | null;
  label?: string | null;
  source?: string;
}

export interface Session {
  id: string;
  day: string;
  type?: string;
  mood?: string | null;
  start_datetime?: string;
  end_datetime?: string;
  // heart_rate / heart_rate_variability / motion_count time-series stay in raw_json
}

export interface EnhancedTag {
  id: string;
  tag_type_code?: string;
  custom_name?: string | null;
  comment?: string | null;
  start_time?: string;
  end_time?: string | null;
  start_day: string;
  end_day?: string | null;
}

export interface RestModePeriod {
  id: string;
  start_day: string;
  end_day?: string | null;
  start_time?: string;
  end_time?: string | null;
  episodes?: unknown[];
}

export interface SleepTime {
  id: string;
  day: string;
  optimal_bedtime?: unknown | null;
  recommendation?: string | null;
  status?: string | null;
}

// ---------- reference / config ----------

export interface PersonalInfo {
  id: string;
  age?: number | null;
  weight?: number | null;      // kg
  height?: number | null;      // meters
  biological_sex?: string | null;
  email?: string | null;
}

export interface RingConfiguration {
  id: string;
  color?: string;
  design?: string;
  hardware_type?: string;
  firmware_version?: string;
  size?: number;
  set_up_at?: string;
}

// ---------- intraday heart rate ----------

export interface Heartrate {
  bpm: number;
  source: string;      // measurement context: awake | rest | sleep | session | live | workout
  timestamp: string;   // ISO 8601 with offset; stored as UTC TIMESTAMP
}

// ---------- ring battery level ----------

export interface RingBatteryLevel {
  timestamp: string;          // ISO 8601 with offset; stored as UTC TIMESTAMP
  level: number;              // battery percentage [0, 100]
  charging?: boolean | null;
  in_charger?: boolean | null;
}

// ---------- shared paginator ----------

// maxPages is a safety valve against runaway loops. Daily-style endpoints finish in a handful of
// pages, so the default 100 is never reached. High-frequency endpoints (heartrate) pass a larger cap.
// If the cap is hit while a next_token is still pending we THROW rather than silently truncate —
// silent data loss on a backfill chunk is far worse than a loud failure the caller can narrow + retry.
async function pagedGet<T>(
  path: string,
  params: Record<string, string>,
  token: string,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams({ ...params, ...(nextToken ? { next_token: nextToken } : {}) });
    const url = `${BASE}${path}?${qs}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`oura ${path} ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: T[]; next_token?: string | null };
    out.push(...body.data);
    if (!body.next_token) return out;
    nextToken = body.next_token;
  }
  throw new Error(`oura ${path}: pagination exceeded ${maxPages} pages — window too large; narrow the range`);
}

async function singleGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`oura ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// ---------- existing 4 endpoints ----------

export async function getDailySleep(token: string, start: string, end: string): Promise<DailySleep[]> {
  return pagedGet("/daily_sleep", { start_date: start, end_date: end }, token);
}
export async function getDailyReadiness(token: string, start: string, end: string): Promise<DailyReadiness[]> {
  return pagedGet("/daily_readiness", { start_date: start, end_date: end }, token);
}
export async function getDailyActivity(token: string, start: string, end: string): Promise<DailyActivity[]> {
  return pagedGet("/daily_activity", { start_date: start, end_date: end }, token);
}
export async function getSleep(token: string, start: string, end: string): Promise<SleepSession[]> {
  return pagedGet("/sleep", { start_date: start, end_date: end }, token);
}

// ---------- new daily-score endpoints ----------

export async function getDailyStress(token: string, start: string, end: string): Promise<DailyStress[]> {
  return pagedGet("/daily_stress", { start_date: start, end_date: end }, token);
}
export async function getDailySpo2(token: string, start: string, end: string): Promise<DailySpo2[]> {
  return pagedGet("/daily_spo2", { start_date: start, end_date: end }, token);
}
export async function getDailyResilience(token: string, start: string, end: string): Promise<DailyResilience[]> {
  return pagedGet("/daily_resilience", { start_date: start, end_date: end }, token);
}
export async function getDailyCardioAge(token: string, start: string, end: string): Promise<DailyCardioAge[]> {
  return pagedGet("/daily_cardiovascular_age", { start_date: start, end_date: end }, token);
}

// ---------- new event endpoints ----------

export async function getVo2Max(token: string, start: string, end: string): Promise<Vo2Max[]> {
  return pagedGet("/vO2_max", { start_date: start, end_date: end }, token);
}
export async function getWorkout(token: string, start: string, end: string): Promise<Workout[]> {
  return pagedGet("/workout", { start_date: start, end_date: end }, token);
}
export async function getSession(token: string, start: string, end: string): Promise<Session[]> {
  return pagedGet("/session", { start_date: start, end_date: end }, token);
}
export async function getEnhancedTag(token: string, start: string, end: string): Promise<EnhancedTag[]> {
  return pagedGet("/enhanced_tag", { start_date: start, end_date: end }, token);
}
export async function getRestModePeriod(token: string, start: string, end: string): Promise<RestModePeriod[]> {
  return pagedGet("/rest_mode_period", { start_date: start, end_date: end }, token);
}
export async function getSleepTime(token: string, start: string, end: string): Promise<SleepTime[]> {
  return pagedGet("/sleep_time", { start_date: start, end_date: end }, token);
}

// ---------- reference / config (no date params) ----------

export async function getPersonalInfo(token: string): Promise<PersonalInfo> {
  return singleGet<PersonalInfo>("/personal_info", token);
}
export async function getRingConfiguration(token: string): Promise<RingConfiguration[]> {
  return pagedGet<RingConfiguration>("/ring_configuration", {}, token);
}

// ---------- intraday heart rate ----------
// ⚠️ heartrate is the ONE Oura endpoint that ranges by start_datetime/end_datetime (ISO datetime),
//    NOT the start_date/end_date the other 14 endpoints use. It's high-frequency (minute-grain), so
//    we give it a generous page cap.

export async function getHeartrate(
  token: string,
  startDateTime: string,
  endDateTime: string,
): Promise<Heartrate[]> {
  return pagedGet<Heartrate>(
    "/heartrate",
    { start_datetime: startDateTime, end_datetime: endDateTime },
    token,
    2000,
  );
}

// ring_battery_level is the second datetime-ranged endpoint (like /heartrate). Sparse series —
// a handful of samples/day — so the default page cap is plenty.
export async function getRingBatteryLevel(
  token: string,
  startDateTime: string,
  endDateTime: string,
): Promise<RingBatteryLevel[]> {
  return pagedGet<RingBatteryLevel>(
    "/ring_battery_level",
    { start_datetime: startDateTime, end_datetime: endDateTime },
    token,
  );
}
