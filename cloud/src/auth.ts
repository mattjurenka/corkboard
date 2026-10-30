// Signing in: the pages the OAuth provider leaves to us. A client (the
// bridge's `corkboard login`, later an MCP client) sends the user to
// /authorize; they approve it here, sign in with Google, and come back to
// /callback, which hands the client its code. Only ALLOWED_EMAIL gets in.
//
// Consent comes before Google, per the provider's upstream-sign-in guide:
// clients register themselves, so each one must be approved by name before
// the user's Google identity is used for it.

import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./index";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { --bg: #fafaf7; --fg: #1d1d1b; --muted: #6b6b66; --line: #d6d6cf; --accent: #1f5fd1; --warn: #a3470c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e8e3; --muted: #9a9a93; --line: #3a3a37; --accent: #7aa7ff; --warn: #f0a060; } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.6 ui-monospace, "JetBrains Mono", Menlo, monospace; margin: 0; }
  main { max-width: 34rem; margin: 4rem auto; padding: 0 16px; }
  h1 { font-size: 1rem; margin: 0 0 1.5rem; border-bottom: 1px solid var(--line); padding-bottom: .75rem; }
  p { margin: 0 0 1rem; } .muted { color: var(--muted); } .warn { color: var(--warn); }
  label { display: block; } button { font: inherit; padding: .4rem 1rem; margin-right: .5rem; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
  button[value=approve] { border-color: var(--accent); color: var(--accent); }
</style>
<main><h1>corkboard · ${escape(title)}</h1>${body}</main>`,
    { status, headers },
  );
}

// What each scope lets a client do, in the user's words.
const SCOPES: Record<string, string> = {
  owner: "everything: all boards and cards, as you",
  assistant: "the board tools (MCP): read every board, change and add cards",
};

function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : `<span class="muted">This app registered itself; its name is not verified.</span>`;
  const scopes = d.scope
    .filter((s) => s in SCOPES)
    .map((s) => `<label><input type="checkbox" name="scope" value="${escape(s)}" checked> <strong>${escape(s)}</strong> <span class="muted">— ${escape(SCOPES[s])}</span></label>`)
    .join("");
  return page(
    `allow ${d.clientName}?`,
    `<p><strong>${name}</strong> wants to use your corkboard.</p>
<p>${origin} Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="warn">That is an app on this computer. Continue only if you just started signing in from it.</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p>${scopes || `<span class="muted">It asks for no access.</span>`}</p>
  <p class="muted">Allowing it continues to Google sign-in.</p>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>`,
    200,
    headers,
  );
}

const redirect = (location: string, headers = new Headers()) => {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
};

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The id token's claims. Its signature isn't checked: it came straight from
// Google's token endpoint over TLS, in exchange for our client secret, which
// OpenID Connect Core 3.1.3.7 accepts in place of validating it.
function claims(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1] ?? "";
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  return JSON.parse(atob(padded));
}

async function googleUser(env: Env, code: string, verifier: string): Promise<{ sub: string; email: string } | string> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.ORIGIN}/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return `Google refused the sign-in (${res.status})`;
  const { id_token } = await res.json<{ id_token?: string }>();
  if (!id_token) return "Google sent no identity";
  const c = claims(id_token);
  if (!["https://accounts.google.com", "accounts.google.com"].includes(c.iss as string)) return "the identity isn't from Google";
  if (c.aud !== env.GOOGLE_CLIENT_ID) return "the identity was issued to another app";
  if (typeof c.exp !== "number" || c.exp * 1000 < Date.now()) return "the identity has expired";
  if (c.email_verified !== true || typeof c.email !== "string") return "the Google account has no verified email";
  return { sub: String(c.sub), email: c.email.toLowerCase() };
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    const req = await oauth.parseAuthRequest(request);
    // The portal (../portal) is ours: a code sent back to this origin
    // reaches only the portal page, so there's no app to approve.
    if (req.redirectUri === `${env.ORIGIN}/`) return toGoogle(env, req);
    const details = await oauth.describeConsent(req);
    const consent = await oauth.beginConsent(req);
    return consentPage(details, consent.handle, consent.headers);
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
  return toGoogle(env, approved.request, approved.headers);
}

// On to Google's sign-in, with the approved request saved for /callback.
async function toGoogle(env: Env, req: AuthRequest, sending?: Headers): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(req, { data: { verifier }, headers: sending });
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.ORIGIN}/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    login_hint: env.ALLOWED_EMAIL,
    prompt: "select_account",
  }).toString();
  return redirect(google.toString(), headers);
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) return redirect(authorizationErrorRedirect(original, "access_denied"), headers);

  const user = await googleUser(env, code, data.verifier);
  if (typeof user === "string") return page("sign-in failed", `<p>${escape(user)}.</p>`, 502, headers);
  if (user.email !== env.ALLOWED_EMAIL.toLowerCase()) {
    console.warn(`refused sign-in from ${user.email}`);
    return redirect(authorizationErrorRedirect(original, "access_denied"), headers);
  }
  const props: Props = { userId: user.sub, email: user.email };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: user.sub,
    metadata: {},
    scope: original.scope,
    props,
  });
  return redirect(redirectTo, headers);
}

export const auth = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/authorize") return await authorize(request, env);
      if (path === "/callback") return await callback(request, env);
      // Every other path is the portal's page (../portal, its own Worker).
      return env.PORTAL ? await env.PORTAL.fetch(request) : new Response("not found", { status: 404 });
    } catch (e) {
      // As the provider's consent-page guide: redirect only to a validated
      // client, render everything else here.
      if (e instanceof AuthorizationError && e.redirectTo) return redirect(e.redirectTo);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
        return page("can't sign in", `<p>${escape(message ?? "The request was not valid.")}</p><p class="muted">Start again from the app.</p>`, 400);
      }
      throw e;
    }
  },
};
