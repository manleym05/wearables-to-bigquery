// Withings v2 API client.
// All endpoints POST application/x-www-form-urlencoded to https://wbsapi.withings.net/<path>
// Response envelope: {status: 0, body: {...}}; non-zero status = error.
// Pagination: most list endpoints return `more` + `offset` for next page.

const API_BASE = "https://wbsapi.withings.net";

interface Envelope<T> {
  status: number;
  body: T;
  error?: string;
}

interface MorePage {
  more?: 0 | 1;
  offset?: number;
}

// ---------- raw types ----------

// /measure?action=getmeas
export interface MeasureValue {
  value: number;
  type: number;  // meastype (1=weight, 6=fat ratio, etc.)
  unit: number;  // value × 10^unit = real value
  algo?: number;
  fm?: number;
}

export interface MeasureGroup {
  grpid: number;
  date: number;          // epoch seconds (UTC)
  created?: number;
  modified?: number;
  attrib: number;        // 0=device auto, 1/2=ambiguous, 4/5=manual entry, 7=manual confirm
  category: number;      // 1=real measurement, 2=user objective
  deviceid?: string;
  hash_deviceid?: string;
  measures: MeasureValue[];
  timezone?: string;
}

export interface MeasureBody extends MorePage {
  updatetime: number;
  timezone: string;
  measuregrps: MeasureGroup[];
}

// /v2/sleep?action=getsummary
export interface SleepSummaryData {
  // a long list — see Withings docs. Stored opaquely in raw_json, scalars extracted by shape.
  deepsleepduration?: number;
  lightsleepduration?: number;
  remsleepduration?: number;
  wakeupduration?: number;
  wakeupcount?: number;
  durationtosleep?: number;
  durationtowakeup?: number;
  total_timeinbed?: number;
  total_sleep_time?: number;
  sleep_efficiency?: number;
  sleep_latency?: number;
  wakeup_latency?: number;
  waso?: number;
  nb_rem_episodes?: number;
  out_of_bed_count?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
  rr_average?: number;
  rr_min?: number;
  rr_max?: number;
  breathing_disturbances_intensity?: number;
  snoring?: number;
  snoringepisodecount?: number;
  sleep_score?: number;
  withings_index?: number;
  hrv_lowest?: number;
  hrv_average?: number;
  night_events?: unknown;
  apnea_hypopnea_index?: number;
  asleepduration?: number;
}

export interface SleepSummarySeries {
  id?: number;
  timezone?: string;
  model?: string;
  model_id?: number;
  hash_deviceid?: string;
  startdate: number;
  enddate: number;
  date: string;         // YYYY-MM-DD
  created?: number;
  modified?: number;
  data: SleepSummaryData;
}

export interface SleepSummaryBody extends MorePage {
  series: SleepSummarySeries[];
}

// /v2/measure?action=getactivity
export interface Activity {
  date: string;          // YYYY-MM-DD
  timezone: string;
  is_tracker?: boolean;
  deviceid?: string;
  hash_deviceid?: string;
  brand?: number;
  steps?: number;
  distance?: number;
  elevation?: number;
  soft?: number;
  moderate?: number;
  intense?: number;
  active?: number;
  calories?: number;
  totalcalories?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
  hr_zone_0?: number;
  hr_zone_1?: number;
  hr_zone_2?: number;
  hr_zone_3?: number;
}

export interface ActivityBody extends MorePage {
  activities: Activity[];
}

// /v2/measure?action=getworkouts
export interface WorkoutData {
  algo_pause_duration?: number;
  calories?: number;
  effduration?: number;
  intensity?: number;
  manual_distance?: number;
  manual_calories?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
  hr_zone_0?: number;
  hr_zone_1?: number;
  hr_zone_2?: number;
  hr_zone_3?: number;
  pause_duration?: number;
  spo2_average?: number;
  steps?: number;
  distance?: number;
  elevation?: number;
  ascent?: number;
  descent?: number;
}

export interface Workout {
  id?: number;
  category: number;
  attrib?: number;
  startdate: number;
  enddate: number;
  date: string;
  timezone?: string;
  modified?: number;
  model?: number;
  model_id?: number;
  deviceid?: string;
  data: WorkoutData;
}

export interface WorkoutsBody extends MorePage {
  series: Workout[];
}

// /v2/heart?action=list
export interface HeartEcg {
  signalid?: number;
  afib?: number;       // 0=neg, 1=pos, 2=inconclusive, etc.
}

export interface HeartBP {
  diastole?: number;
  systole?: number;
}

export interface HeartSeries {
  deviceid?: string;
  model?: number;
  ecg?: HeartEcg;
  bloodpressure?: HeartBP;
  heart_rate?: number;
  timestamp: number;
  timezone?: string;
}

export interface HeartListBody extends MorePage {
  series: HeartSeries[];
}

// /v2/user?action=getdevice
export interface Device {
  type?: string;
  battery?: string;
  model?: string;
  model_id?: number;
  timezone?: string;
  first_session_date?: number;
  last_session_date?: number;
  hash_deviceid?: string;
  deviceid?: string;
}

export interface DeviceBody {
  devices: Device[];
}

// ---------- helper ----------

async function post<T>(path: string, params: Record<string, string>, accessToken: string): Promise<T> {
  const body = new URLSearchParams(params);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`withings ${path} HTTP ${res.status}: ${await res.text()}`);
  const env_ = (await res.json()) as Envelope<T>;
  if (env_.status !== 0) {
    throw new Error(`withings ${path} status=${env_.status} error=${env_.error ?? "?"}`);
  }
  return env_.body;
}

async function postPaged<TItem, TBody extends MorePage>(
  path: string,
  baseParams: Record<string, string>,
  accessToken: string,
  itemsKey: string,
): Promise<TItem[]> {
  const out: TItem[] = [];
  let offset = 0;
  for (let i = 0; i < 100; i++) {
    const params = { ...baseParams, ...(offset ? { offset: String(offset) } : {}) };
    const body = await post<TBody>(path, params, accessToken);
    const arr = ((body as unknown as Record<string, TItem[]>)[itemsKey] as TItem[]) ?? [];
    out.push(...arr);
    if (!body.more || body.offset == null) break;
    offset = body.offset;
  }
  return out;
}

// ---------- endpoints ----------
// Withings uses startdate/enddate (epoch) for /measure and /v2/heart; startdateymd/enddateymd
// (YYYY-MM-DD) for /v2/sleep and /v2/measure?action=getactivity/getworkouts.

function ymdToEpoch(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 1000);
}

function ymdToEpochEnd(ymd: string): number {
  // inclusive end: end of day UTC
  return Math.floor(Date.parse(`${ymd}T23:59:59Z`) / 1000);
}

export async function getMeasures(accessToken: string, startYmd: string, endYmd: string): Promise<MeasureGroup[]> {
  // Pull ALL measure types Withings knows about. Comma-separated list per Withings convention.
  // 1=weight 4=height 5=fat-free-mass 6=fat-ratio 8=fat-mass-weight 9=diastolic 10=systolic
  // 11=heart-pulse 12=temperature 54=spo2 71=body-temp 73=skin-temp 76=muscle-mass 77=hydration
  // 88=bone-mass 91=pulse-wave-velocity 123=vo2-max 130=afib-burden 135=afib-result(detail)
  // 155=afib-result 167=vascular-age 168=nervehealth
  const meastypes = "1,4,5,6,8,9,10,11,12,54,71,73,76,77,88,91,123,130,135,155,167,168";
  const body = await postPaged<MeasureGroup, MeasureBody>(
    "/measure",
    {
      action: "getmeas",
      meastypes,
      startdate: String(ymdToEpoch(startYmd)),
      enddate: String(ymdToEpochEnd(endYmd)),
    },
    accessToken,
    "measuregrps",
  );
  return body;
}

export async function getSleepSummaries(accessToken: string, startYmd: string, endYmd: string): Promise<SleepSummarySeries[]> {
  return postPaged<SleepSummarySeries, SleepSummaryBody>(
    "/v2/sleep",
    {
      action: "getsummary",
      startdateymd: startYmd,
      enddateymd: endYmd,
      data_fields: [
        "deepsleepduration", "lightsleepduration", "remsleepduration", "wakeupduration",
        "wakeupcount", "durationtosleep", "durationtowakeup", "total_timeinbed",
        "total_sleep_time", "sleep_efficiency", "sleep_latency", "wakeup_latency", "waso",
        "nb_rem_episodes", "out_of_bed_count",
        "hr_average", "hr_min", "hr_max", "rr_average", "rr_min", "rr_max",
        "breathing_disturbances_intensity", "snoring", "snoringepisodecount",
        "sleep_score", "withings_index", "hrv_lowest", "hrv_average",
        "apnea_hypopnea_index", "asleepduration", "night_events",
      ].join(","),
    },
    accessToken,
    "series",
  );
}

export async function getActivities(accessToken: string, startYmd: string, endYmd: string): Promise<Activity[]> {
  return postPaged<Activity, ActivityBody>(
    "/v2/measure",
    {
      action: "getactivity",
      startdateymd: startYmd,
      enddateymd: endYmd,
      data_fields: [
        "steps", "distance", "elevation", "soft", "moderate", "intense", "active",
        "calories", "totalcalories",
        "hr_average", "hr_min", "hr_max", "hr_zone_0", "hr_zone_1", "hr_zone_2", "hr_zone_3",
      ].join(","),
    },
    accessToken,
    "activities",
  );
}

export async function getWorkouts(accessToken: string, startYmd: string, endYmd: string): Promise<Workout[]> {
  return postPaged<Workout, WorkoutsBody>(
    "/v2/measure",
    {
      action: "getworkouts",
      startdateymd: startYmd,
      enddateymd: endYmd,
      data_fields: [
        "calories", "effduration", "intensity", "manual_distance", "manual_calories",
        "hr_average", "hr_min", "hr_max", "hr_zone_0", "hr_zone_1", "hr_zone_2", "hr_zone_3",
        "pause_duration", "algo_pause_duration", "spo2_average",
        "steps", "distance", "elevation", "ascent", "descent",
      ].join(","),
    },
    accessToken,
    "series",
  );
}

export async function getHeartList(accessToken: string, startYmd: string, endYmd: string): Promise<HeartSeries[]> {
  return postPaged<HeartSeries, HeartListBody>(
    "/v2/heart",
    {
      action: "list",
      startdate: String(ymdToEpoch(startYmd)),
      enddate: String(ymdToEpochEnd(endYmd)),
    },
    accessToken,
    "series",
  );
}

export async function getDevices(accessToken: string): Promise<Device[]> {
  const body = await post<DeviceBody>("/v2/user", { action: "getdevice" }, accessToken);
  return body.devices ?? [];
}
