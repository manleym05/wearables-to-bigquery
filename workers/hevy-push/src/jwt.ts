// Mint a Google OAuth2 access token from a SA JSON key via Web Crypto.
// Scope = BigQuery only; this worker doesn't touch anything else on GCP.

interface SAKey { client_email: string; private_key: string; token_uri?: string }
interface CachedToken { token: string; expiresAt: number }

let cached: CachedToken | null = null;
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";

export async function getGcpAccessToken(saKeyJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 300 > now) return cached.token;

  const sa: SAKey = JSON.parse(saKeyJson);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope: BQ_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = await signRS256(unsigned, sa.private_key);
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`gcp token exchange ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: now + j.expires_in };
  return cached.token;
}

async function signRS256(data: string, pemPrivateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(pemPrivateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return b64urlBytes(new Uint8Array(sig));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(s: string): string { return b64urlBytes(new TextEncoder().encode(s)); }
function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
