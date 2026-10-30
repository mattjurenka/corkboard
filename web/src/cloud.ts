// The Worker, for a page it serves itself (/edit/, a page with no machine):
// the portal's sign-in, shared. The portal is an OAuth client of the Worker
// on this same origin and keeps its tokens in localStorage (portal/lib/
// api.ts); this page reads them there each time rather than keeping its own
// copy, since refresh tokens rotate and the portal may have refreshed since.
// Signing in goes by way of the portal, which comes back here after.

const KEY = "corkboard.portal";

type Auth = { client_id?: string; access_token?: string; refresh_token?: string; expires_at?: number; signed_out?: boolean };

function load(): Auth {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// As the portal's signIn, coming back to this page: the portal's "/" takes
// the code and sends the browser on to back.
async function signIn(): Promise<never> {
  let a = load();
  if (!a.client_id) {
    const reg = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "corkboard portal", redirect_uris: [`${location.origin}/`], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    });
    if (reg.status !== 201) throw new Error(`couldn't register: ${await reg.text()}`);
    a = { client_id: (await reg.json()).client_id };
    localStorage.setItem(KEY, JSON.stringify(a));
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, back: location.pathname + location.search }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: a.client_id!,
    redirect_uri: `${location.origin}/`,
    scope: "owner",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(`/authorize?${q}`);
  return new Promise<never>(() => {});
}

let pending: Promise<string> | null = null;

// A current access token: the portal's, refreshed when it's within a
// minute of expiring (or stale, when the Worker turned it down).
export function token(stale = false): Promise<string> {
  const a = load();
  if (a.access_token && !stale && (a.expires_at ?? 0) > Date.now() + 60_000) return Promise.resolve(a.access_token);
  pending ??= (async () => {
    if (a.refresh_token && a.client_id) {
      const res = await fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: a.client_id, grant_type: "refresh_token", refresh_token: a.refresh_token }),
      });
      if (res.ok) {
        const t = await res.json();
        const next = { ...load(), access_token: t.access_token, refresh_token: t.refresh_token ?? a.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
        delete next.signed_out;
        localStorage.setItem(KEY, JSON.stringify(next));
        return next.access_token;
      }
    }
    return signIn();
  })().finally(() => (pending = null));
  return pending;
}

// A WebSocket to the Worker, signed in: a browser can't set its headers,
// so the token goes as a subprotocol (cloud/src/index.ts takes it there).
export function socket(url: string, t: string): WebSocket {
  return new WebSocket(url, ["corkboard", `corkboard.bearer.${b64url(new TextEncoder().encode(t))}`]);
}

// The Worker's JSON, signed in.
export async function api<T = any>(path: string): Promise<T> {
  for (const stale of [false, true]) {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${await token(stale)}` } });
    if (res.status === 401 && !stale) continue;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json as T;
  }
  throw new Error("signed out");
}
