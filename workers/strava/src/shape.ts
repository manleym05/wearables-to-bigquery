// Strava payloads -> staging row shapes.

import type { SummaryActivity, DetailedAthlete, AthleteZones } from "./strava";

const dayInTz = (iso: string | undefined, tz: string): string | null => {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
};

// ---------- raw_strava_activity ----------

export interface ActivityRow {
  subject_id: number;
  activity_id: number;
  day: string;
  external_id: string | null;
  upload_id: number | null;
  name: string | null;
  type: string | null;
  sport_type: string | null;
  workout_type: number | null;
  start_at: string | null;
  start_at_local: string | null;
  timezone: string | null;
  utc_offset_s: number | null;
  distance_m: number | null;
  moving_time_s: number | null;
  elapsed_time_s: number | null;
  elevation_gain_m: number | null;
  elev_high_m: number | null;
  elev_low_m: number | null;
  avg_speed_m_s: number | null;
  max_speed_m_s: number | null;
  avg_cadence: number | null;
  avg_temp_c: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  has_heartrate: boolean | null;
  avg_watts: number | null;
  max_watts: number | null;
  weighted_avg_watts: number | null;
  device_watts: boolean | null;
  kilojoules: number | null;
  suffer_score: number | null;
  calories: number | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  gear_id: string | null;
  device_name: string | null;
  is_trainer: boolean | null;
  is_commute: boolean | null;
  is_manual: boolean | null;
  is_private: boolean | null;
  visibility: string | null;
  pr_count: number | null;
  achievement_count: number | null;
  kudos_count: number | null;
  comment_count: number | null;
  athlete_count: number | null;
  photo_count: number | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  summary_polyline: string | null;
  source: "strava_api";
  raw_json: string;
  ingested_at: string;
}

export function buildActivityRows(subjectId: number, items: SummaryActivity[], tz: string, ingestedAt: string): ActivityRow[] {
  return items.map((a) => ({
    subject_id: subjectId,
    activity_id: a.id,
    day: dayInTz(a.start_date_local ?? a.start_date, tz) ?? "1970-01-01",
    external_id: a.external_id ?? null,
    upload_id: a.upload_id ?? null,
    name: a.name ?? null,
    type: a.type ?? null,
    sport_type: a.sport_type ?? null,
    workout_type: a.workout_type ?? null,
    start_at: a.start_date ?? null,
    start_at_local: a.start_date_local ?? null,
    timezone: a.timezone ?? null,
    utc_offset_s: a.utc_offset ?? null,
    distance_m: a.distance ?? null,
    moving_time_s: a.moving_time ?? null,
    elapsed_time_s: a.elapsed_time ?? null,
    elevation_gain_m: a.total_elevation_gain ?? null,
    elev_high_m: a.elev_high ?? null,
    elev_low_m: a.elev_low ?? null,
    avg_speed_m_s: a.average_speed ?? null,
    max_speed_m_s: a.max_speed ?? null,
    avg_cadence: a.average_cadence ?? null,
    avg_temp_c: a.average_temp ?? null,
    avg_hr_bpm: a.average_heartrate ?? null,
    max_hr_bpm: a.max_heartrate ?? null,
    has_heartrate: a.has_heartrate ?? null,
    avg_watts: a.average_watts ?? null,
    max_watts: a.max_watts ?? null,
    weighted_avg_watts: a.weighted_average_watts ?? null,
    device_watts: a.device_watts ?? null,
    kilojoules: a.kilojoules ?? null,
    suffer_score: a.suffer_score ?? null,
    calories: a.calories ?? null,
    start_lat: a.start_latlng?.[0] ?? null,
    start_lng: a.start_latlng?.[1] ?? null,
    end_lat: a.end_latlng?.[0] ?? null,
    end_lng: a.end_latlng?.[1] ?? null,
    gear_id: a.gear_id ?? null,
    device_name: a.device_name ?? null,
    is_trainer: a.trainer ?? null,
    is_commute: a.commute ?? null,
    is_manual: a.manual ?? null,
    is_private: a.private ?? null,
    visibility: a.visibility ?? null,
    pr_count: a.pr_count ?? null,
    achievement_count: a.achievement_count ?? null,
    kudos_count: a.kudos_count ?? null,
    comment_count: a.comment_count ?? null,
    athlete_count: a.athlete_count ?? null,
    photo_count: a.photo_count ?? a.total_photo_count ?? null,
    location_city: a.location_city ?? null,
    location_state: a.location_state ?? null,
    location_country: a.location_country ?? null,
    summary_polyline: a.map?.summary_polyline ?? null,
    source: "strava_api",
    raw_json: JSON.stringify(a),
    ingested_at: ingestedAt,
  }));
}

// ---------- raw_strava_athlete ----------

export interface AthleteRow {
  subject_id: number;
  athlete_id: number;
  username: string | null;
  firstname: string | null;
  lastname: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  sex: string | null;
  premium: boolean | null;
  summit: boolean | null;
  weight_kg: number | null;
  ftp_watts: number | null;
  measurement_preference: string | null;
  created_at: string | null;
  updated_at: string | null;
  source: "strava_api";
  raw_json: string;
  ingested_at: string;
}

export function buildAthleteRow(subjectId: number, a: DetailedAthlete, ingestedAt: string): AthleteRow {
  return {
    subject_id: subjectId,
    athlete_id: a.id,
    username: a.username ?? null,
    firstname: a.firstname ?? null,
    lastname: a.lastname ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    country: a.country ?? null,
    sex: a.sex ?? null,
    premium: a.premium ?? null,
    summit: a.summit ?? null,
    weight_kg: a.weight ?? null,
    ftp_watts: a.ftp ?? null,
    measurement_preference: a.measurement_preference ?? null,
    created_at: a.created_at ?? null,
    updated_at: a.updated_at ?? null,
    source: "strava_api",
    raw_json: JSON.stringify(a),
    ingested_at: ingestedAt,
  };
}

// ---------- raw_strava_zones ----------

export interface ZonesRow {
  subject_id: number;
  hr_zones_json: string | null;
  power_zones_json: string | null;
  hr_zones_custom: boolean | null;
  power_zones_custom: boolean | null;
  source: "strava_api";
  raw_json: string;
  ingested_at: string;
}

export function buildZonesRow(subjectId: number, z: AthleteZones, ingestedAt: string): ZonesRow {
  return {
    subject_id: subjectId,
    hr_zones_json: z.heart_rate?.zones ? JSON.stringify(z.heart_rate.zones) : null,
    power_zones_json: z.power?.zones ? JSON.stringify(z.power.zones) : null,
    hr_zones_custom: z.heart_rate?.custom_zones ?? null,
    power_zones_custom: z.power?.custom_zones ?? null,
    source: "strava_api",
    raw_json: JSON.stringify(z),
    ingested_at: ingestedAt,
  };
}
