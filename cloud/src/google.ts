// Google's id tokens, checked as OpenID Connect Core 3.1.3.7 says: signed
// with one of Google's keys (its JWKS, kept in memory as long as Google's
// Cache-Control says, and fetched again for a key it hasn't seen, which is
// how Google's rotation shows), by Google, for our client, and unexpired.

const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

let cached: { keys: Map<string, CryptoKey>; until: number } | undefined;

async function fetchKeys(): Promise<Map<string, CryptoKey>> {
  const res = await fetch(CERTS);
  if (!res.ok) throw new Error(`Google's keys: HTTP ${res.status}`);
  const { keys: jwks = [] } = await res.json<{ keys?: (JsonWebKey & { kid?: string })[] }>();
  const keys = new Map<string, CryptoKey>();
  for (const { kid, ...k } of jwks) if (kid && k.kty === "RSA") keys.set(kid, await crypto.subtle.importKey("jwk", k, RS256, false, ["verify"]));
  const age = Number(res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
  cached = { keys, until: Date.now() + Math.min(age, 86400) * 1000 };
  return keys;
}

async function keyFor(kid: string): Promise<CryptoKey | undefined> {
  if (cached && cached.until > Date.now() && cached.keys.has(kid)) return cached.keys.get(kid);
  return (await fetchKeys()).get(kid);
}

const bytes = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4)), (c) => c.charCodeAt(0));
const decode = (part: string) => JSON.parse(new TextDecoder().decode(bytes(part)));

// The token's claims, or why it isn't one to trust.
export async function verifyIdToken(token: string, clientId: string): Promise<Record<string, unknown> | string> {
  const [h, p, s, ...more] = token.split(".");
  if (!h || !p || !s || more.length) return "the identity isn't a signed token";
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = decode(h);
    claims = decode(p);
  } catch {
    return "the identity can't be read";
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return "the identity isn't signed as Google signs";
  const key = await keyFor(header.kid);
  if (!key) return "the identity is signed with a key that isn't Google's";
  if (!(await crypto.subtle.verify(RS256, key, bytes(s), new TextEncoder().encode(`${h}.${p}`)))) return "the identity's signature is wrong";
  if (!ISSUERS.includes(claims.iss as string)) return "the identity isn't from Google";
  if (claims.aud !== clientId) return "the identity was issued to another app";
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return "the identity has expired";
  return claims;
}
