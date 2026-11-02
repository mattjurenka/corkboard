// The Claude calendar, written by the node: cloud/src/calendar.ts's plan
// write, with the Google refresh token on this machine instead of in the
// Worker's User object. An accepted day goes on the calendar as the Worker
// wrote it: clear the rest of the day, write the blocks that aren't fixed,
// then the approval marker, last, since it vouches for the rest.
//
//   <state>/node/calendar.json   { client_id, client_secret, refresh, calendar, timezone }, 0600
//
// `corkboard-bridge serve calendar-login` makes it: Google's consent for a
// desktop OAuth client of the user's own (its id and secret given as flags or
// GOOGLE_CLIENT_ID/SECRET), back to a loopback port, and a "Claude" calendar
// made if none is named. `--file` takes one made elsewhere.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DAY_STARTS_HOUR, type Plan, today } from "../../lib/model/plans";
import { random } from "../../lib/e2ee/keys";
import { b64url } from "../../lib/e2ee/wire";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.app.created";
const APPROVAL = "✅ Plan approved";

export type CalendarConfig = { client_id: string; client_secret: string; refresh: string; calendar: string; timezone: string };

export class CalendarError extends Error {}

export function loadCalendar(path: string): CalendarConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CalendarConfig;
    return c.refresh && c.calendar ? c : undefined;
  } catch {
    return undefined;
  }
}

export function saveCalendar(path: string, c: CalendarConfig) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function accessToken(c: CalendarConfig, f: Fetch): Promise<string> {
  const res = await f(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh, grant_type: "refresh_token" }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (res.ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant") throw new CalendarError("Google no longer takes the calendar's sign-in; run corkboard-bridge serve calendar-login again");
  throw new CalendarError(`Google refused a token for the calendar (${res.status}${body.error ? `: ${body.error}` : ""})`);
}

function offset(timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d\d):?(\d\d)?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}
const pad = (n: number) => String(n).padStart(2, "0");
const local = (date: string, m: number) => `${date}T${m >= 24 * 60 ? "23:59" : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`}:00`;
function instant(timeZone: string, date: string, m: number): string {
  const naive = local(date, m);
  return naive + offset(timeZone, new Date(`${naive}Z`));
}
const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
function minutesNow(timeZone: string, date: string): number {
  const at = new Date();
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).split(":").map(Number);
  return h * 60 + m + (new Intl.DateTimeFormat("en-CA", { timeZone }).format(at) === date ? 0 : 24 * 60);
}

// cloud/src/calendar.ts's: what's still ahead (all of another day's) and
// isn't fixed. Copied, since that file brings the Worker's types with it.
function calendarBlocks(blocks: Plan["day"]["blocks"], from: number) {
  return blocks.filter((b) => b.kind !== "fixed" && b.stop > from).map((b) => ({ title: b.title, desc: b.desc ?? "", start: Math.max(b.start, from), stop: b.stop }));
}

// The accepted day onto the calendar; how many blocks it got.
export async function writePlan(c: CalendarConfig, plan: Pick<Plan, "date" | "day">, f: Fetch = fetch): Promise<number> {
  const zone = c.timezone;
  const token = await accessToken(c, f);
  const cal = `${API}/calendars/${encodeURIComponent(c.calendar)}/events`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await f(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (method === "DELETE" && res.status === 410) return {};
    if (!res.ok) throw new CalendarError(`Google Calendar ${method} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? {} : ((await res.json()) as Record<string, any>);
  };
  const from = plan.date === today(zone) ? minutesNow(zone, plan.date) : 0;
  const stale = await call(
    "GET",
    `${cal}?${new URLSearchParams({ timeMin: instant(zone, plan.date, from), timeMax: instant(zone, nextDay(plan.date), DAY_STARTS_HOUR * 60), singleEvents: "true", maxResults: "250" })}`,
  );
  for (const e of (stale.items ?? []) as { id: string; status?: string }[]) if (e.status !== "cancelled") await call("DELETE", `${cal}/${encodeURIComponent(e.id)}`);
  const blocks = calendarBlocks(plan.day.blocks, from);
  for (const b of blocks)
    await call("POST", cal, {
      summary: b.title,
      description: b.desc,
      start: { dateTime: local(plan.date, b.start), timeZone: zone },
      end: { dateTime: local(plan.date, b.stop), timeZone: zone },
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

// Google's consent in the browser, back to a port on this machine; then the
// calendar, made if none was named.
export async function login(o: { client_id: string; client_secret: string; calendar?: string; timezone: string; path: string }) {
  const verifier = b64url(random(32));
  const state = b64url(random(16));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let done!: (code: string) => void;
  const got = new Promise<string>((r) => (done = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) return new Response("not found", { status: 404 });
      const code = u.searchParams.get("code");
      if (code) done(code);
      return new Response(code ? "Connected. You can close this tab." : `Google said: ${u.searchParams.get("error")}`);
    },
  });
  const redirect = `http://127.0.0.1:${server.port}/callback`;
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: o.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  console.log(`Open this to connect the calendar:\n\n  ${url}\n`);
  const code = await got;
  server.stop();
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.client_id, client_secret: o.client_secret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !t.refresh_token) throw new CalendarError(`Google gave no refresh token (${t.error ?? res.status})`);
  let calendar = o.calendar;
  if (!calendar) {
    const made = await fetch(`${API}/calendars`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Claude", description: "Day plans accepted in corkboard.", timeZone: o.timezone }),
    });
    const body = (await made.json().catch(() => ({}))) as { id?: string };
    if (!made.ok || !body.id) throw new CalendarError(`Google Calendar didn't make the calendar (${made.status})`);
    calendar = body.id;
  }
  saveCalendar(o.path, { client_id: o.client_id, client_secret: o.client_secret, refresh: t.refresh_token, calendar, timezone: o.timezone });
  return calendar;
}
