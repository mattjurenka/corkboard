// Signing in: the pages the OAuth provider leaves to us. A client (the
// bridge's `corkboard login`, later an MCP client) sends the user to
// /authorize; they approve it here, sign in with Google, and come back to
// /callback, which hands the client its code. Who gets in is the
// registry's (registry.ts): admins, anyone already in, and anyone with a
// good invite, which comes as /authorize?invite= and rides through Google
// with the request. Anyone else is put on the waitlist.
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
import { STATE_PREFIX, calendarError, connect, createCalendar, verifierFor } from "./calendar";
import { verifyIdToken } from "./google";
import type { Env, Props } from "./index";
import { type InviteProblem, admins, forgetAccount, registry, welcome } from "./registry";
import { zone } from "./user";

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

function consentPage(d: ConsentDescription, handle: string, headers: Headers, invite?: string): Response {
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
  ${invite ? `<input type="hidden" name="invite" value="${escape(invite)}">` : ""}
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

type GoogleUser = { sub: string; email: string; name: string | null; access?: string; refresh?: string };

// refresh: Google's refresh token, which comes only with an offline consent
// (the calendar's, calendar.ts). name: with the profile scope.
async function googleUser(env: Env, code: string, verifier: string): Promise<GoogleUser | string> {
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
  const { id_token, access_token, refresh_token } = await res.json<{ id_token?: string; access_token?: string; refresh_token?: string }>();
  if (!id_token) return "Google sent no identity";
  const c = await verifyIdToken(id_token, env.GOOGLE_CLIENT_ID);
  if (typeof c === "string") return c;
  if (c.email_verified !== true || typeof c.email !== "string") return "the Google account has no verified email";
  if (typeof c.sub !== "string" || !c.sub) return "the identity names no account";
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 80) : null;
  return { sub: c.sub, email: c.email.toLowerCase(), name, ...(access_token && { access: access_token }), ...(refresh_token && { refresh: refresh_token }) };
}

const INVITE = /^[\w-]{1,64}$/;
const inviteOf = (v: unknown) => (typeof v === "string" && INVITE.test(v) ? v : undefined);

const PROBLEMS: Record<InviteProblem, string> = {
  unknown: "That invite isn't one of ours.",
  used: "That invite has been used up.",
  expired: "That invite has expired.",
  revoked: "That invite was withdrawn.",
};

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    const req = await oauth.parseAuthRequest(request);
    const invite = inviteOf(new URL(request.url).searchParams.get("invite"));
    // The portal (../portal) is ours: a code sent back to this origin
    // reaches only the portal page, so there's no app to approve.
    if (req.redirectUri === `${env.ORIGIN}/`) return toGoogle(env, req, undefined, invite);
    const details = await oauth.describeConsent(req);
    const consent = await oauth.beginConsent(req);
    return consentPage(details, consent.handle, consent.headers, invite);
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
  return toGoogle(env, approved.request, approved.headers, inviteOf(form.get("invite")));
}

// On to Google's sign-in, with the approved request (and any invite) saved
// for /callback. No login_hint: who's signing in isn't known until Google says.
async function toGoogle(env: Env, req: AuthRequest, sending?: Headers, invite?: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(req, { data: { verifier, ...(invite && { invite }) }, headers: sending });
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.ORIGIN}/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return redirect(google.toString(), headers);
}

async function callback(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).searchParams.get("state")?.startsWith(STATE_PREFIX)) return calendarConnected(request, env);
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; invite?: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) return redirect(authorizationErrorRedirect(original, "access_denied"), headers);

  const user = await googleUser(env, code, data.verifier);
  if (typeof user === "string") return page("sign-in failed", `<p>${escape(user)}.</p>`, 502, headers);
  const { account, problem } = await registry(env).signIn(user, admins(env).includes(user.email), data.invite);
  forgetAccount(user.sub);
  if (account.status === "disabled") {
    console.warn(`refused sign-in from ${user.email}: disabled`);
    return page("can't sign in", `<p>${escape(user.email)} can't use this corkboard.</p>`, 403, headers);
  }
  if (account.status !== "active")
    return page(
      "waitlist",
      `<p>You're on the waitlist.</p><p class="muted">${escape(user.email)}</p>${problem ? `<p class="warn">${PROBLEMS[problem]}</p>` : ""}`,
      403,
      headers,
    );
  // Their settings start from where they first signed in once let in.
  const cf = (request as { cf?: { timezone?: string } }).cf;
  await welcome(env, user.sub, user.email, { name: user.name, timezone: zone(cf?.timezone) });
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

// Back from the calendar's consent (calendar.ts's connect). Google's
// identity is what says whose calendar it is, and it must be someone let
// in. Without a calendar in their settings, one is made for them.
async function calendarConnected(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const verifier = await verifierFor(env, params.get("state")!);
  const code = params.get("code");
  const failed = (why: string, status: number) => page("calendar not connected", why, status);
  if (!verifier) return failed('<p>That consent has expired.</p><p class="muted">Start again at /calendar/connect.</p>', 400);
  if (params.get("error") || !code) return failed("<p>Google didn't give corkboard the calendar.</p>", 400);
  const user = await googleUser(env, code, verifier);
  if (typeof user === "string") return failed(`<p>${escape(user)}.</p>`, 502);
  const { account } = await registry(env).check(user.sub, user.email, admins(env).includes(user.email));
  if (account?.status !== "active") return failed(`<p>${escape(user.email)} isn't signed in to this corkboard.</p>`, 403);
  if (!user.refresh) return failed('<p>Google sent no refresh token.</p><p class="muted">Start again at /calendar/connect.</p>', 502);
  const users = env.USER.get(env.USER.idFromName(user.sub));
  await users.connectCalendar(user.refresh);
  const settings = await users.settings();
  if (!settings.calendar) {
    try {
      await users.setSettings({ calendar: await createCalendar(env, user.access, settings.timezone) });
    } catch (e) {
      return failed(`<p>${escape(calendarError(e))}.</p>`, 502);
    }
  }
  return page("calendar connected", "<p>Accepted plans now go on the Claude calendar.</p>");
}

export const auth = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/authorize") return await authorize(request, env);
      if (path === "/callback") return await callback(request, env);
      if (path === "/calendar/connect") return await connect(env);
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
