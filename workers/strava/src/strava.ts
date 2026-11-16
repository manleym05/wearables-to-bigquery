// Strava v3 API client.
// Rate limits: 100/15min, 1000/day per app+user. Comfortable for our scope.
// Pagination: page (1-indexed) + per_page (max 200) until empty array.

const API_BASE = "https://www.strava.com/api/v3";

export interface SummaryActivity {
  id: number;
  external_id?: string | null;
  upload_id?: number | null;
  name: string;
  description?: string | null;
  type: string;                   // 'Run', 'Ride', 'Walk', 'Hike', 'Swim', ...
  sport_type?: string;
  workout_type?: number | null;
  start_date: string;             // ISO 8601 UTC
  start_date_local: string;
  timezone?: string;              // "(GMT-05:00) America/New_York"
  utc_offset?: number;
  distance?: number;              // meters
  moving_time?: number;           // seconds
  elapsed_time?: number;
  total_elevation_gain?: number;
  average_speed?: number;
  max_speed?: number;
  average_cadence?: number;
  average_temp?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  has_heartrate?: boolean;
  average_watts?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  device_watts?: boolean;
  kilojoules?: number;
  suffer_score?: number;
  calories?: number;
  start_latlng?: [number, number];
  end_latlng?: [number, number];
  gear_id?: string | null;
  device_name?: string;
  trainer?: boolean;
  commute?: boolean;
  manual?: boolean;
  private?: boolean;
  visibility?: string;
  flagged?: boolean;
  pr_count?: number;
  achievement_count?: number;
  kudos_count?: number;
  comment_count?: number;
  athlete_count?: number;
  photo_count?: number;
  total_photo_count?: number;
  elev_high?: number;
  elev_low?: number;
  location_city?: string | null;
  location_state?: string | null;
  location_country?: string | null;
  map?: { id?: string; summary_polyline?: string };
}

export interface DetailedAthlete {
  id: number;
  username?: string;
  firstname?: string;
  lastname?: string;
  city?: string;
  state?: string;
  country?: string;
  sex?: string;
  premium?: boolean;
  summit?: boolean;
  created_at?: string;
  updated_at?: string;
  badge_type_id?: number;
  weight?: number;                // kg
  profile?: string;
  profile_medium?: string;
  ftp?: number | null;
  measurement_preference?: string;
  bikes?: unknown[];
  shoes?: unknown[];
}

export interface ZoneBucket { min: number; max: number }
export interface ZoneData { zones: ZoneBucket[]; custom_zones?: boolean }
export interface AthleteZones {
  heart_rate?: ZoneData;
  power?: ZoneData;
}

async function get<T>(path: string, params: Record<string, string>, accessToken: string): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`strava ${path} HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Page through /athlete/activities with after/before unix-second filters.
export async function getActivities(accessToken: string, startYmd: string, endYmd: string): Promise<SummaryActivity[]> {
  const after = Math.floor(Date.parse(`${startYmd}T00:00:00Z`) / 1000);
  const before = Math.floor(Date.parse(`${endYmd}T23:59:59Z`) / 1000);
  const out: SummaryActivity[] = [];
  const perPage = 200;
  for (let page = 1; page < 100; page++) {
    const arr = await get<SummaryActivity[]>(
      "/athlete/activities",
      { after: String(after), before: String(before), page: String(page), per_page: String(perPage) },
      accessToken,
    );
    out.push(...arr);
    if (arr.length < perPage) break;
  }
  return out;
}

export async function getAthlete(accessToken: string): Promise<DetailedAthlete> {
  return get<DetailedAthlete>("/athlete", {}, accessToken);
}

export async function getAthleteZones(accessToken: string): Promise<AthleteZones> {
  return get<AthleteZones>("/athlete/zones", {}, accessToken);
}
