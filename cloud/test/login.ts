// Signing in as a client would, against the Worker: register, consent, a
// faked Google, the callback, and the code exchange. Google's token endpoint
// is the only thing stubbed; everything else is the real provider.

import { exports } from "cloudflare:workers";
import { vi } from "vitest";

export const ORIGIN = "https://corkboard.test";
const REDIRECT = "http://127.0.0.1:9999/callback";

export const worker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init));

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64bytes = (b: ArrayBuffer) => b64url(String.fromCharCode(...new Uint8Array(b)));

// Google's signing key, made here: its public half is what the stubbed
// JWKS endpoint serves.
export const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const KID = `test-${crypto.randomUUID()}`;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const keys = crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

export async function certs(): Promise<Response> {
  const jwk = (await crypto.subtle.exportKey("jwk", (await keys).publicKey)) as JsonWebKey;
  return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }, { headers: { "Cache-Control": "public, max-age=3600" } });
}

// An id token as Google's would be; forged: signed with a key that isn't the one served.
export async function idToken(claims: Record<string, unknown>, opts: { forged?: boolean } = {}): Promise<string> {
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const key = opts.forged ? (await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ["sign"]) as CryptoKeyPair).privateKey : (await keys).privateKey;
  return `${head}.${b64bytes(await crypto.subtle.sign(RS256, key, new TextEncoder().encode(head)))}`;
}

export const claimsFor = (email: string, sub = `sub-${email}`, overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: "google-client",
  sub,
  email,
  email_verified: true,
  name: email.split("@")[0],
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

// The next sign-in at Google comes back as this account.
export function google(email: string, sub = `sub-${email}`, overrides: Record<string, unknown> = {}, opts: { forged?: boolean } = {}) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS) return certs();
    if (url !== "https://oauth2.googleapis.com/token") return real(input, init);
    return Response.json({ access_token: "g", id_token: await idToken(claimsFor(email, sub, overrides), opts) });
  });
}

class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function pkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

export async function register(redirect = REDIRECT) {
  const res = await worker("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "corkboard bridge",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
  return (await res.json<{ client_id: string }>()).client_id;
}

// Up to the consent page; returns what the rest of the flow needs.
export async function consent(scope = "owner", redirect = REDIRECT, invite?: string) {
  const clientId = await register(redirect);
  const { verifier, challenge } = await pkce();
  const jar = new Jar();
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(invite && { invite }),
  }).toString();
  const res = await worker(url.toString());
  jar.take(res);
  const html = await res.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  return { res, html, handle, jar, clientId, verifier, redirect };
}

// The whole flow. Returns the client's redirect, and tokens if it got a code.
export async function login(opts: { scope?: string; decision?: string; approve?: string[]; redirect?: string; invite?: string } = {}) {
  const c = await consent(opts.scope, opts.redirect, opts.invite);
  if (!c.handle) throw new Error(`no consent page: ${c.res.status} ${c.html}`);
  const form = new URLSearchParams({ handle: c.handle, decision: opts.decision ?? "approve" });
  const invite = c.html.match(/name="invite" value="([^"]+)"/)?.[1];
  if (invite) form.set("invite", invite);
  for (const s of opts.approve ?? (opts.scope ?? "owner").split(" ")) form.append("scope", s);
  const approved = await worker("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: c.jar.header() },
    body: form,
    redirect: "manual",
  });
  c.jar.take(approved);
  const toGoogle = new URL(approved.headers.get("Location") ?? "");
  if (toGoogle.origin !== "https://accounts.google.com") return { redirect: toGoogle };

  const back = await worker(`/callback?code=google-code&state=${toGoogle.searchParams.get("state")}`, {
    headers: { Cookie: c.jar.header() },
    redirect: "manual",
  });
  if (back.status !== 302) return { status: back.status, body: await back.text() };
  const redirect = new URL(back.headers.get("Location")!);
  const code = redirect.searchParams.get("code");
  if (!code) return { redirect };

  const token = await worker("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: c.redirect,
      client_id: c.clientId,
      code_verifier: c.verifier,
    }),
  });
  const tokens = await token.json<{ access_token: string; refresh_token: string; scope: string }>();
  return { redirect, tokens, clientId: c.clientId, toGoogle };
}

// A signed-in owner's access token: the admin's (ADMIN_EMAILS, in
// vitest.config.ts), or anyone's with an invite.
export async function ownerToken(email = "me@example.com", invite?: string) {
  google(email);
  const { tokens, status, body } = await login({ invite });
  vi.restoreAllMocks();
  if (!tokens?.access_token) throw new Error(`sign-in failed: ${status} ${body}`);
  return tokens.access_token;
}

// Pepper, as the first admin's account has it from before new accounts
// started with a plain assistant (brains.ts's STARTER): the default brain,
// with chat, a Claude account and two holds.
export async function pepper(token: string) {
  const res = await worker("/api/brains", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "pepper", title: "Pepper", description: "The user's personal assistant.", account: "personal", credentials: ["google", "corkboard"], abilities: ["chat"], default: true }),
  });
  if (res.status !== 201) throw new Error(`pepper: ${res.status} ${await res.text()}`);
}

// A second user, let in by an invite the admin's token makes: their token.
export async function invitedToken(admin: string, email = "you@example.com") {
  const res = await worker("/api/admin/invites", {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: email }),
  });
  if (res.status !== 201) throw new Error(`invite: ${res.status} ${await res.text()}`);
  return ownerToken(email, (await res.json<{ code: string }>()).code);
}
