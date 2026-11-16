// Google Maps Directions API client.
// Docs: https://developers.google.com/maps/documentation/directions/

const BASE = "https://maps.googleapis.com/maps/api/directions/json";

export type Mode = "driving" | "walking" | "bicycling" | "transit";
export type DayType = "weekday" | "weekend";

export interface DirectionsRequest {
  origin: string;
  destination: string;
  mode: Mode;
  departureHour: number;   // 0-23 in user's timezone
  dayType: DayType;
  apiKey: string;
  timezone: string;
}

export interface DirectionsLegSummary {
  status: string;
  duration_s: number | null;
  duration_text: string | null;
  duration_in_traffic_s: number | null;
  duration_in_traffic_text: string | null;
  distance_m: number | null;
  distance_text: string | null;
  start_address: string | null;
  end_address: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  route_summary: string | null;
  warnings: string[];
  copyrights: string | null;
  polyline: string | null;
  raw: unknown;
  departure_time_used: string;   // ISO 8601 of the future timestamp we sent to Maps
}

/** Compute the next occurrence of (hour, dayType) in TZ as an absolute future timestamp.
 *  Maps requires departure_time to be NOW or in the future for traffic estimates. */
export function nextDepartureTimestamp(hour: number, dayType: DayType, timezone: string): Date {
  const now = new Date();
  // Iterate forward day-by-day in TZ until we hit a matching weekday/weekend
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const candidate = new Date(now);
    candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(candidate);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    const matches = dayType === "weekend" ? isWeekend : !isWeekend;
    if (!matches) continue;

    // Compose the candidate date at `hour:00` in the TZ. Use Intl to find the UTC instant.
    const ymd = isoYmdInTz(candidate, timezone);
    const guess = new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00`);
    // Adjust by the TZ offset for that date — done via formatToParts on the guess
    const tzOffsetMin = tzOffsetMinutes(guess, timezone);
    const utcMs = Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)),
      hour, 0, 0,
    ) - tzOffsetMin * 60_000;
    const result = new Date(utcMs);
    if (result.getTime() > now.getTime() + 60_000) return result;   // must be in future
  }
  // Fallback: 1 week from now at requested hour
  const fb = new Date(now);
  fb.setUTCDate(fb.getUTCDate() + 7);
  fb.setUTCHours(hour, 0, 0, 0);
  return fb;
}

function isoYmdInTz(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function tzOffsetMinutes(d: Date, timezone: string): number {
  // Compute "minutes east of UTC" for the given instant in the given TZ.
  const tzString = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, timeZoneName: "shortOffset",
  }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzString);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const mins = m[3] ? Number(m[3]) : 0;
  return sign * (hours * 60 + mins);
}

export async function fetchDirections(req: DirectionsRequest): Promise<DirectionsLegSummary> {
  const departureTime = nextDepartureTimestamp(req.departureHour, req.dayType, req.timezone);
  const params: Record<string, string> = {
    origin: req.origin,
    destination: req.destination,
    mode: req.mode,
    units: "imperial",
    key: req.apiKey,
  };
  // departure_time only meaningful for driving + transit
  if (req.mode === "driving" || req.mode === "transit") {
    params.departure_time = String(Math.floor(departureTime.getTime() / 1000));
  }
  if (req.mode === "driving") params.traffic_model = "best_guess";

  const url = `${BASE}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`maps directions HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    status: string;
    error_message?: string;
    routes: Array<{
      summary?: string;
      copyrights?: string;
      warnings?: string[];
      overview_polyline?: { points?: string };
      legs: Array<{
        duration?: { value: number; text: string };
        duration_in_traffic?: { value: number; text: string };
        distance?: { value: number; text: string };
        start_address?: string;
        end_address?: string;
        start_location?: { lat: number; lng: number };
        end_location?: { lat: number; lng: number };
      }>;
    }>;
  };

  if (body.status !== "OK") {
    throw new Error(`maps status=${body.status} ${body.error_message ?? ""}`);
  }
  const route = body.routes[0];
  const leg = route?.legs?.[0];
  return {
    status: body.status,
    duration_s: leg?.duration?.value ?? null,
    duration_text: leg?.duration?.text ?? null,
    duration_in_traffic_s: leg?.duration_in_traffic?.value ?? null,
    duration_in_traffic_text: leg?.duration_in_traffic?.text ?? null,
    distance_m: leg?.distance?.value ?? null,
    distance_text: leg?.distance?.text ?? null,
    start_address: leg?.start_address ?? null,
    end_address: leg?.end_address ?? null,
    start_lat: leg?.start_location?.lat ?? null,
    start_lng: leg?.start_location?.lng ?? null,
    end_lat: leg?.end_location?.lat ?? null,
    end_lng: leg?.end_location?.lng ?? null,
    route_summary: route?.summary ?? null,
    warnings: route?.warnings ?? [],
    copyrights: route?.copyrights ?? null,
    polyline: route?.overview_polyline?.points ?? null,
    raw: body,
    departure_time_used: departureTime.toISOString(),
  };
}

// Canonical-ish cache key.
export async function buildCacheKey(
  origin: string, dest: string, mode: Mode, hour: number, dayType: DayType,
): Promise<string> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const raw = `${norm(origin)}|${norm(dest)}|${mode}|${hour}|${dayType}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
