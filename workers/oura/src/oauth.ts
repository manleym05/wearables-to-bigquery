// Oura OAuth 2.0 state machine (PAT replacement — PATs deprecated Dec 2025, dying with
// "Oura on the Web" retirement). Mirrors the Withings pattern: Oura refresh tokens are
// single-use, so the new refresh_token MUST be persisted immediately after every refresh
// or the chain breaks and the owner has to re-authorize via browser.

import type { Env } from "./env";

const AUTH_BASE = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";

const KV_REFRESH_TOKEN = "oauth_refresh_token";
const KV_ACCESS_TOKEN = "oauth_access_token";
const KV_ACCESS_EXPIRES = "oauth_access_token_expires_at"; // epoch seconds (string)

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: env.OURA_CLIENT_ID,
    scope: env.OURA_SCOPE,
    redirect_uri: env.OURA_REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${qs}`;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.OURA_CLIENT_ID,
    client_secret: env.OURA_CLIENT_SECRET,
    ...params,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`oura token endpoint HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<TokenResponse> {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OURA_REDIRECT_URI,
  });
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function persistTokens(env: Env, tokens: TokenResponse): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
  // Critical: write refresh_token FIRST. Refresh tokens are single-use, so if the
  // access-token write fails the new refresh token is already safe and the next
  // invocation can recover.
  await env.OURA_STATE.put(KV_REFRESH_TOKEN, tokens.refresh_token);
  await env.OURA_STATE.put(KV_ACCESS_TOKEN, tokens.access_token);
  await env.OURA_STATE.put(KV_ACCESS_EXPIRES, String(expiresAt));
}

export async function hasOAuthGrant(env: Env): Promise<boolean> {
  return (await env.OURA_STATE.get(KV_REFRESH_TOKEN)) !== null;
}

// Get a valid Oura API bearer token.
//   1. OAuth grant in KV → cached access token, refreshed when <5 min from expiry.
//   2. No grant yet but OURA_PAT secret still set → fall back to the PAT (transition
//      window only — lets us deploy this code before the one-time browser authorize).
export async function getOuraToken(env: Env): Promise<string> {
  const [cached, expiresAtStr] = await Promise.all([
    env.OURA_STATE.get(KV_ACCESS_TOKEN),
    env.OURA_STATE.get(KV_ACCESS_EXPIRES),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  if (cached && expiresAt - 300 > now) return cached;

  const refresh = await env.OURA_STATE.get(KV_REFRESH_TOKEN);
  if (refresh) {
    const tokens = await refreshTokens(env, refresh);
    await persistTokens(env, tokens);
    return tokens.access_token;
  }

  if (env.OURA_PAT) {
    console.log(JSON.stringify({ kind: "auth_warning", msg: "using deprecated PAT — complete /oauth/start before Oura on the Web retires" }));
    return env.OURA_PAT;
  }

  throw new Error("no Oura OAuth grant in KV and no OURA_PAT fallback — visit /oauth/start to authorize");
}
