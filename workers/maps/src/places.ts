// Google Places API (New) — Text Search.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
//
// Use case: SCEN-06 (away from home, find a park/gym/loop near the hotel) and any time the
// brain needs to surface nearby resources. Text Search accepts a free-form query + optional
// location bias (circle of radius around a lat/lng) and returns a ranked list of matching places.
//
// API enablement: requires "Places API (New)" enabled in Google Cloud Console for the same
// project as the Directions key. If enabled but the key has no place-API access scope, the
// response is HTTP 403; if not enabled at all, HTTP 403 with a SERVICE_DISABLED reason.
//
// Cost note: the new API bills per session keyed off the FieldMask. Including only Basic
// fields (id, displayName, location, types) is the cheapest tier; rating + userRatingCount
// move into the Pro tier. Keep the FieldMask narrow.

const BASE = "https://places.googleapis.com/v1/places:searchText";

// Basic-tier + a couple cheap fields. Cost-tier reference:
//   Basic: id, types, addressComponents, formattedAddress, location, displayName, viewport
//   Pro:   rating, userRatingCount, priceLevel, businessStatus, currentOpeningHours
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.currentOpeningHours.openNow",
  "places.priceLevel",
].join(",");

export interface PlacesRequest {
  query: string;
  /** Optional bias circle — { lat, lng } center; if string passed via /places, parsed upstream. */
  location?: { lat: number; lng: number };
  /** Optional bias-circle radius in meters. Max 50000. Only meaningful with location. */
  radius?: number;
  /** Optional Google place-type filter (e.g. "park", "gym", "restaurant"). */
  type?: string;
  /** Optional cap on results. Google returns up to 20 per page; we don't paginate. Default 10. */
  maxResults?: number;
  apiKey: string;
}

export interface PlaceSummary {
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  rating: number | null;
  user_ratings_total: number | null;
  types: string[];
  business_status: string | null;
  open_now: boolean | null;
  price_level: string | null;
}

export interface PlacesResponse {
  status: string;
  count: number;
  results: PlaceSummary[];
  raw_status: string;
  raw_error?: string;
  request: {
    query: string;
    location?: { lat: number; lng: number } | string;
    radius?: number;
    type?: string;
  };
}

export async function fetchPlaces(req: PlacesRequest): Promise<PlacesResponse> {
  const body: Record<string, unknown> = {
    textQuery: req.query,
    maxResultCount: Math.max(1, Math.min(20, req.maxResults ?? 10)),
  };
  if (req.location) {
    body.locationBias = {
      circle: {
        center: { latitude: req.location.lat, longitude: req.location.lng },
        radius: Math.min(50000, Math.max(1, req.radius ?? 5000)),
      },
    };
  }
  if (req.type) body.includedType = req.type;

  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": req.apiKey,
      "x-goog-fieldmask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: {
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      types?: string[];
      businessStatus?: string;
      rating?: number;
      userRatingCount?: number;
      currentOpeningHours?: { openNow?: boolean };
      priceLevel?: string;
    }>;
    error?: { status?: string; message?: string };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`places non-JSON HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    return {
      status: parsed.error?.status ?? `HTTP_${res.status}`,
      count: 0,
      results: [],
      raw_status: parsed.error?.status ?? String(res.status),
      raw_error: parsed.error?.message ?? text.slice(0, 300),
      request: { query: req.query, location: req.location, radius: req.radius, type: req.type },
    };
  }

  const places = parsed.places ?? [];
  const summaries: PlaceSummary[] = places.map((p) => ({
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    place_id: p.id ?? null,
    rating: p.rating ?? null,
    user_ratings_total: p.userRatingCount ?? null,
    types: p.types ?? [],
    business_status: p.businessStatus ?? null,
    open_now: p.currentOpeningHours?.openNow ?? null,
    price_level: p.priceLevel ?? null,
  }));

  return {
    status: "OK",
    count: summaries.length,
    results: summaries,
    raw_status: "OK",
    request: { query: req.query, location: req.location, radius: req.radius, type: req.type },
  };
}
