import type { Env } from "./env";
import { getGcpAccessToken } from "./jwt";
import { fetchDirections, buildCacheKey, type Mode, type DayType } from "./maps";
import { fetchPlaces } from "./places";
import { readCache, writeCache } from "./cache";

function requireAdmin(env: Env, url: URL, req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = url.searchParams.get("token") ?? auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

const VALID_MODES = new Set<Mode>(["driving", "walking", "bicycling", "transit"]);
const VALID_DAY_TYPES = new Set<DayType>(["weekday", "weekend"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname !== "/directions" && url.pathname !== "/places") {
      return new Response(
        "cornerstone-maps:\n" +
        "  /healthz\n" +
        "  /directions?origin=<addr>&destination=<addr>" +
        "&mode=<driving|walking|bicycling|transit>" +
        "&departure_hour=<0-23>&day_type=<weekday|weekend>" +
        "&nocache=1&token=<ADMIN_TOKEN>\n" +
        "  /places?query=<text>&location=<lat,lng>&radius=<m>&type=<google_type>&max_results=<n>&token=<ADMIN_TOKEN>",
        { status: 404, headers: { "content-type": "text/plain" } },
      );
    }

    const denied = requireAdmin(env, url, req);
    if (denied) return denied;

    if (url.pathname === "/places") {
      return await handlePlaces(url, env);
    }

    const origin = (url.searchParams.get("origin") ?? "").trim();
    const destination = (url.searchParams.get("destination") ?? "").trim();
    const mode = (url.searchParams.get("mode") ?? "driving") as Mode;
    const departureHour = Number(url.searchParams.get("departure_hour") ?? "8");
    const dayType = (url.searchParams.get("day_type") ?? "weekday") as DayType;
    const noCache = url.searchParams.get("nocache") === "1";

    if (!origin || !destination) {
      return new Response("origin and destination required", { status: 400 });
    }
    if (!VALID_MODES.has(mode)) {
      return new Response(`invalid mode (one of: ${[...VALID_MODES].join("|")})`, { status: 400 });
    }
    if (!Number.isInteger(departureHour) || departureHour < 0 || departureHour > 23) {
      return new Response("departure_hour must be 0..23", { status: 400 });
    }
    if (!VALID_DAY_TYPES.has(dayType)) {
      return new Response(`invalid day_type (weekday|weekend)`, { status: 400 });
    }

    const cacheKey = await buildCacheKey(origin, destination, mode, departureHour, dayType);
    const subjectId = Number(env.SUBJECT_ID);

    try {
      const gcpToken = await getGcpAccessToken(env.GCP_SA_KEY);

      if (!noCache) {
        const cached = await readCache(env.GCP_PROJECT, env.BQ_DATASET, cacheKey, gcpToken);
        if (cached) {
          return Response.json({
            cached: true,
            cache_key: cacheKey,
            origin, destination, mode, departure_hour: departureHour, day_type: dayType,
            duration_s: cached.duration_s,
            duration_text: cached.duration_text,
            duration_in_traffic_s: cached.duration_in_traffic_s,
            distance_m: cached.distance_m,
            distance_text: cached.distance_text,
            route_summary: cached.route_summary,
            cached_until: cached.cached_until,
            requested_at: cached.requested_at,
          });
        }
      }

      const result = await fetchDirections({
        origin, destination, mode,
        departureHour, dayType,
        apiKey: env.MAPS_API_KEY,
        timezone: env.TIMEZONE,
      });

      await writeCache({
        projectId: env.GCP_PROJECT,
        dataset: env.BQ_DATASET,
        accessToken: gcpToken,
        subjectId,
        cacheKey,
        origin, destination, mode,
        departureHour, dayType,
        result,
        ttlDays: Number(env.CACHE_TTL_DAYS),
      });

      return Response.json({
        cached: false,
        cache_key: cacheKey,
        origin, destination, mode, departure_hour: departureHour, day_type: dayType,
        duration_s: result.duration_s,
        duration_text: result.duration_text,
        duration_in_traffic_s: result.duration_in_traffic_s,
        duration_in_traffic_text: result.duration_in_traffic_text,
        distance_m: result.distance_m,
        distance_text: result.distance_text,
        route_summary: result.route_summary,
        start_address: result.start_address,
        end_address: result.end_address,
        departure_time_used: result.departure_time_used,
      });
    } catch (err) {
      return new Response(`directions failed: ${(err as Error).message}`, { status: 500 });
    }
  },
};

// /places — Google Places Text Search proxy. Unlike /directions we don't cache to BQ in v1
// (results are query-shaped and harder to dedupe cleanly; add caching when usage justifies).
async function handlePlaces(url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) return new Response("query required", { status: 400 });

  const locationRaw = url.searchParams.get("location");
  let location: { lat: number; lng: number } | undefined;
  if (locationRaw) {
    const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(locationRaw);
    if (!m) return new Response("location must be 'lat,lng' decimal", { status: 400 });
    location = { lat: Number(m[1]), lng: Number(m[2]) };
  }

  const radiusRaw = url.searchParams.get("radius");
  const radius = radiusRaw ? Number(radiusRaw) : undefined;
  if (radius != null && (!Number.isFinite(radius) || radius < 1 || radius > 50000)) {
    return new Response("radius must be 1..50000 meters", { status: 400 });
  }

  const type = url.searchParams.get("type") ?? undefined;
  const maxResultsRaw = url.searchParams.get("max_results");
  const maxResults = maxResultsRaw ? Number(maxResultsRaw) : 10;

  try {
    const result = await fetchPlaces({
      query,
      ...(location !== undefined ? { location } : {}),
      ...(radius !== undefined ? { radius } : {}),
      ...(type ? { type } : {}),
      maxResults,
      apiKey: env.MAPS_API_KEY,
    });
    return Response.json(result, { status: result.status === "OK" ? 200 : 502 });
  } catch (err) {
    return new Response(`places failed: ${(err as Error).message}`, { status: 500 });
  }
}
