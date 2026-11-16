// Withings OAuth 2.0 state machine.
// Withings rotates the refresh_token on every refresh — must persist the new one
// immediately or the chain breaks and the user has to re-authorize via browser.

import type { Env } from "./env";

const AUTH_BASE = "https://account.withings.com/oauth2_user/authorize2";
const TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

const KV_REFRESH_TOKEN = "refresh_token";
const KV_ACCESS_TOKEN = "access_token";
const KV_ACCESS_EXPIRES = "access_token_expires_at"; // epoch seconds (string)
const KV_USER_ID = "withings_user_id";

interface TokenResponse {
  userid: string | number;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface WithingsEnvelope<T> {
  status: number;
  body: T;
  error?: string;
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: env.WITHINGS_CLIENT_ID,
    scope: env.WITHINGS_SCOPE,
    redirect_uri: env.WITHINGS_REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${qs}`;
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: env.WITHINGS_CLIENT_ID,
    client_secret: env.WITHINGS_CLIENT_SECRET,
    code,
    redirect_uri: env.WITHINGS_REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`withings token exchange HTTP ${res.status}: ${await res.text()}`);
  const env_ = (await res.json()) as WithingsEnvelope<TokenResponse>;
  if (env_.status !== 0) {
    throw new Error(`withings token exchange status=${env_.status} error=${env_.error ?? "?"}`);
  }
  return env_.body;
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: env.WITHINGS_CLIENT_ID,
    client_secret: env.WITHINGS_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`withings refresh HTTP ${res.status}: ${await res.text()}`);
  const env_ = (await res.json()) as WithingsEnvelope<TokenResponse>;
  if (env_.status !== 0) {
    throw new Error(`withings refresh status=${env_.status} error=${env_.error ?? "?"}`);
  }
  return env_.body;
}

export async function persistTokens(env: Env, tokens: TokenResponse): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
  // Critical: write refresh_token FIRST. If the access-token write fails, we still
  // have the new refresh token saved and can continue.
  await env.WITHINGS_STATE.put(KV_REFRESH_TOKEN, tokens.refresh_token);
  await env.WITHINGS_STATE.put(KV_ACCESS_TOKEN, tokens.access_token);
  await env.WITHINGS_STATE.put(KV_ACCESS_EXPIRES, String(expiresAt));
  await env.WITHINGS_STATE.put(KV_USER_ID, String(tokens.userid));
}

// Get a valid Withings access token. Refreshes if expired or about to expire.
export async function getWithingsAccessToken(env: Env): Promise<string> {
  const [cached, expiresAtStr] = await Promise.all([
    env.WITHINGS_STATE.get(KV_ACCESS_TOKEN),
    env.WITHINGS_STATE.get(KV_ACCESS_EXPIRES),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  if (cached && expiresAt - 300 > now) return cached;

  const refresh = await env.WITHINGS_STATE.get(KV_REFRESH_TOKEN);
  if (!refresh) {
    throw new Error("no Withings refresh_token in KV — visit /oauth/start to authorize");
  }
  const tokens = await refreshTokens(env, refresh);
  await persistTokens(env, tokens);
  return tokens.access_token;
}

export async function getWithingsUserId(env: Env): Promise<string | null> {
  return env.WITHINGS_STATE.get(KV_USER_ID);
}
