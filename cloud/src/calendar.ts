// The Claude calendar, written by the Worker: each accepted plan's day goes
// on it, whichever client accepted it. The plan here is the source of truth
// (dayplan reads it for the gate); the calendar is what the phone's routine,
// Pepper and anyone looking at Google Calendar see of it.
//
// The owner connects it once at /calendar/connect: a Google consent for
// calendar.events, separate from signing in, whose refresh token the User
// object keeps. Writing is what `dayplan apply` did: clear the rest of the
// day, write the blocks (not the fixed ones, which are already someone's
// events), then the approval marker, last, since it vouches for the rest.

import type { Env } from "./index";
import { DAY_STARTS_HOUR, type Block, type Plan, today } from "./plans";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// What the gate, the phone's routine and dayplan look for.
export const APPROVAL = "✅ Plan approved";

// The state of a connect under way: Google sends it back to /callback,
// which tells it from a sign-in's by the prefix.
export const STATE_PREFIX = "calendar.";
const stateKey = (state: string) => `calendar-state:${state}`;

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function connect(env: Env): Promise<Response> {
  const state = STATE_PREFIX + crypto.randomUUID();
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  await env.OAUTH_KV.put(stateKey(state), verifier, { expirationTtl: 600 });
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.ORIGIN}/callback`,
    response_type: "code",
    scope: `openid email ${CALENDAR_SCOPE}`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    login_hint: env.ALLOWED_EMAIL,
    // A refresh token comes only with a fresh consent.
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return Response.redirect(google.toString(), 302);
}

// The connect's verifier, once: null for a state that isn't ours or has expired.
export async function verifierFor(env: Env, state: string): Promise<string | null> {
  const verifier = await env.OAUTH_KV.get(stateKey(state));
  if (verifier) await env.OAUTH_KV.delete(stateKey(state));
  return verifier;
}

// What the User object keeps.
export type Connection = { refresh: string; connected: string };

class CalendarError extends Error {}

async function accessToken(env: Env, c: Connection): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: c.refresh,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json<{ access_token?: string; error?: string }>().catch(() => ({}) as { access_token?: string; error?: string });
  if (res.ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant") throw new CalendarError(`Google no longer takes the calendar's sign-in; connect it again at ${env.ORIGIN}/calendar/connect`);
  throw new CalendarError(`Google refused a token for the calendar (${res.status}${body.error ? `: ${body.error}` : ""})`);
}

// "GMT-07:00" -> "-07:00": the zone's offset at that moment.
function offset(timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d\d):?(\d\d)?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

const pad = (n: number) => String(n).padStart(2, "0");
// Minutes since the date's midnight as a local time; the day's end is 23:59,
// as dayplan's marker is.
const local = (date: string, m: number) => `${date}T${m >= 24 * 60 ? "23:59" : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`}:00`;
// The same as an instant, for the API's timeMin and timeMax.
function instant(timeZone: string, date: string, m: number): string {
  const naive = local(date, m);
  return naive + offset(timeZone, new Date(`${naive}Z`));
}
const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);

// Minutes since the plan's midnight now, where the user is: past 1440
// before 4am, when it's still the day before's plan.
function minutesNow(timeZone: string, date: string): number {
  const at = new Date();
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).split(":").map(Number);
  const calendarDay = new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
  return h * 60 + m + (calendarDay === date ? 0 : 24 * 60);
}

// The blocks the calendar gets: what's still ahead (all of another day's)
// and isn't fixed.
export function calendarBlocks(blocks: Block[], from: number): { title: string; desc: string; start: number; stop: number }[] {
  return blocks
    .filter((b) => b.kind !== "fixed" && b.stop > from)
    .map((b) => ({ title: b.title, desc: b.desc ?? "", start: Math.max(b.start, from), stop: b.stop }));
}

// The accepted day onto the calendar. Returns how many blocks were written.
export async function write(env: Env, c: Connection | null, plan: Plan): Promise<number> {
  if (!c) throw new CalendarError(`the calendar isn't connected; connect it at ${env.ORIGIN}/calendar/connect`);
  if (!env.CALENDAR_ID) throw new CalendarError("the Worker has no CALENDAR_ID");
  const zone = env.TIMEZONE;
  const token = await accessToken(env, c);
  const cal = `${API}/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // An event already gone is gone.
    if (method === "DELETE" && res.status === 410) return {};
    if (!res.ok) throw new CalendarError(`Google Calendar ${method} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? {} : res.json<Record<string, any>>();
  };

  const from = plan.date === today(zone) ? minutesNow(zone, plan.date) : 0;
  // From now to when the day turns over: a re-plan at noon leaves the
  // morning's blocks as the record of what was planned, and owns the rest.
  const stale = await call(
    "GET",
    `${cal}?${new URLSearchParams({
      timeMin: instant(zone, plan.date, from),
      timeMax: instant(zone, nextDay(plan.date), DAY_STARTS_HOUR * 60),
      singleEvents: "true",
      maxResults: "250",
    })}`,
  );
  for (const e of (stale.items ?? []) as { id: string; status?: string }[])
    if (e.status !== "cancelled") await call("DELETE", `${cal}/${encodeURIComponent(e.id)}`);

  const blocks = calendarBlocks(plan.day.blocks, from);
  for (const b of blocks)
    await call("POST", cal, {
      summary: b.title,
      description: b.desc,
      start: { dateTime: local(plan.date, b.start), timeZone: zone },
      end: { dateTime: local(plan.date, b.stop), timeZone: zone },
      // The phone's buzz at the start of each block, not the calendar's defaults.
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    });
  await call("POST", cal, {
    summary: APPROVAL,
    description: "The day's plan is accepted while this event is running.",
    start: { dateTime: local(plan.date, from), timeZone: zone },
    end: { dateTime: local(plan.date, 24 * 60), timeZone: zone },
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [] },
  });
  return blocks.length;
}

export const calendarError = (e: unknown) => (e instanceof CalendarError ? e.message : `writing the calendar failed: ${(e as Error).message ?? e}`);
