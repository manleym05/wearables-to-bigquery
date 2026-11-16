// Strava OAuth 2.0. Refresh tokens are long-lived (don't expire unless revoked).
// Differences vs Withings: response uses `expires_at` (epoch) not `expires_in` (delta);
// initial code-exchange returns `athlete` object too.

import type { Env } from "./env";

const AUTH_BASE = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";

const KV_REFRESH_TOKEN = "refresh_token";
const KV_ACCESS_TOKEN = "access_token";
const KV_ACCESS_EXPIRES = "access_token_expires_at";
const KV_ATHLETE_ID = "athlete_id";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;            // epoch seconds (NOT delta)
  expires_in: number;
  token_type: string;
  athlete?: { id: number; username?: string; firstname?: string; lastname?: string };
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const qs = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    redirect_uri: env.STRAVA_REDIRECT_URI,
    response_type: "code",
    approval_prompt: "force",
    scope: env.STRAVA_SCOPE,
    state,
  });
  return `${AUTH_BASE}?${qs}`;
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`strava code exchange HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`strava refresh HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function persistTokens(env: Env, tokens: TokenResponse): Promise<void> {
  await env.STRAVA_STATE.put(KV_REFRESH_TOKEN, tokens.refresh_token);
  await env.STRAVA_STATE.put(KV_ACCESS_TOKEN, tokens.access_token);
  await env.STRAVA_STATE.put(KV_ACCESS_EXPIRES, String(tokens.expires_at));
  if (tokens.athlete?.id) await env.STRAVA_STATE.put(KV_ATHLETE_ID, String(tokens.athlete.id));
}

export async function getStravaAccessToken(env: Env): Promise<string> {
  const [cached, expiresAtStr] = await Promise.all([
    env.STRAVA_STATE.get(KV_ACCESS_TOKEN),
    env.STRAVA_STATE.get(KV_ACCESS_EXPIRES),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  if (cached && expiresAt - 300 > now) return cached;

  const refresh = await env.STRAVA_STATE.get(KV_REFRESH_TOKEN);
  if (!refresh) throw new Error("no Strava refresh_token in KV — visit /oauth/start to authorize");
  const tokens = await refreshTokens(env, refresh);
  await persistTokens(env, tokens);
  return tokens.access_token;
}
