import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CERTS, certs, claimsFor, idToken, invitedToken, login, ownerToken, worker } from "./login";

let owner: string;
let assistant: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function tool(token: string, name: string, args: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse((await res.json<any>()).result.content[0].text);
}

// Tomorrow, where the user is, so it's written whole.
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date(Date.now() - 4 * 3600_000 + 86400_000));
const CAL = "https://www.googleapis.com/calendar/v3/calendars/claude%40group.calendar.google.com/events";
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Google: its token endpoint, for the calendar's consent and its refreshes,
// and the Claude calendar, as a list of events.
type Event = { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string } };
function fakeGoogle(opts: { email?: string; expired?: boolean } = {}) {
  const real = globalThis.fetch;
  const google = { events: [] as Event[], calls: [] as string[], refreshes: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (req.url === "https://oauth2.googleapis.com/token") {
      const form = await req.formData();
      if (form.get("grant_type") === "refresh_token") {
        google.refreshes++;
        if (opts.expired) return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(form.get("refresh_token")).toBe("g-refresh");
        return Response.json({ access_token: "g-access" });
      }
      const email = opts.email ?? "me@example.com";
      return Response.json({ access_token: "g-access", refresh_token: "g-refresh", id_token: await idToken(claimsFor(email)) });
    }
    if (req.url === CERTS) return certs();
    if (url.origin !== "https://www.googleapis.com") return real(input, init);
    expect(req.headers.get("Authorization")).toBe("Bearer g-access");
    google.calls.push(`${req.method} ${url.pathname.split("/").pop()}`);
    if (req.method === "GET") {
      const lo = Date.parse(url.searchParams.get("timeMin")!);
      const hi = Date.parse(url.searchParams.get("timeMax")!);
      // Local times here are Phoenix's, -07:00 all year.
      const at = (d: string) => Date.parse(`${d}-07:00`);
      return Response.json({ items: google.events.filter((e) => at(e.end.dateTime) > lo && at(e.start.dateTime) < hi) });
    }
    if (req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      google.events = google.events.filter((e) => e.id !== id);
      return new Response(null, { status: 204 });
    }
    const event = { id: `e${google.events.length + google.calls.length}`, ...(await req.json<any>()) };
    google.events.push(event);
    return Response.json(event);
  });
  return google;
}

async function connect(email?: string) {
  const res = await worker("/calendar/connect", { redirect: "manual" });
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("Location")!);
  const back = await worker(`/callback?code=google-code&state=${to.searchParams.get("state")}`);
  return { to, back, html: await back.text() };
}

const block = (id: string, start: number, stop: number, extra: object = {}) => ({ id, start, stop, title: `Jobs: ${id}`, kind: "work", ...extra });

async function accept(blocks = [block("linkedin", 540, 600, { desc: "Open LinkedIn" }), block("class", 600, 690, { kind: "fixed" }), block("twilio", 700, 760)]) {
  const p = await tool(assistant, "plan_propose", { date: DATE, from: 0, blocks, reasons: [{ text: "first plan" }], why: {} });
  const res = await call(owner, "POST", `/api/plans/${DATE}/accept`, { version: p.version, blocks: p.proposal.blocks });
  expect(res.status).toBe(200);
  return res.json<any>();
}

// How writing the calendar went, once it has.
async function written() {
  for (let i = 0; i < 50; i++) {
    const p = await (await call(owner, "GET", `/api/plans/${DATE}`)).json<any>();
    if (p.calendar) return p;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the calendar was never written");
}

beforeEach(async () => {
  owner = await ownerToken();
  fakeGoogle();
  const { tokens } = await login({ scope: "assistant" });
  vi.restoreAllMocks();
  assistant = tokens!.access_token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the calendar", () => {
  it("is connected with an offline consent for calendar.events", async () => {
    fakeGoogle();
    const { to, back, html } = await connect();
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.get("scope")).toMatch(/calendar\.events/);
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(back.status).toBe(200);
    expect(html).toMatch(/calendar connected/);
  });

  it("isn't connected for another Google account, or from a state that isn't ours", async () => {
    fakeGoogle({ email: "someone@else.com" });
    expect((await connect()).back.status).toBe(403);
    expect((await worker("/callback?code=x&state=calendar.forged")).status).toBe(400);
  });

  it("gets each accepted day: the work, not what's fixed, and the approval last", async () => {
    const google = fakeGoogle();
    await connect();
    const accepted = await accept();
    const p = await written();
    expect(p.calendar).toMatchObject({ accepted: accepted.accepted, blocks: 2 });
    expect(p.version).toBe(accepted.version);
    expect(google.events.map((e) => [e.summary, e.start.dateTime, e.end.dateTime])).toEqual([
      ["Jobs: linkedin", `${DATE}T09:00:00`, `${DATE}T10:00:00`],
      ["Jobs: twilio", `${DATE}T11:40:00`, `${DATE}T12:40:00`],
      ["✅ Plan approved", `${DATE}T00:00:00`, `${DATE}T23:59:00`],
    ]);
  });

  it("is rewritten by a re-plan, and by an edit of the accepted day", async () => {
    const google = fakeGoogle();
    await connect();
    await accept();
    await written();
    const again = await accept([block("gym", 480, 540)]);
    await written();
    expect(google.events.map((e) => e.summary)).toEqual(["Jobs: gym", "✅ Plan approved"]);
    const edited = await call(owner, "PUT", `/api/plans/${DATE}/day`, { version: again.version, blocks: [block("gym", 480, 540, { title: "Gym, legs" })] });
    expect(edited.status).toBe(200);
    for (let i = 0; i < 50 && !google.events.some((e) => e.summary === "Gym, legs"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(google.events.map((e) => e.summary)).toEqual(["Gym, legs", "✅ Plan approved"]);
  });

  it("says why it wasn't written: not connected, or the consent gone", async () => {
    fakeGoogle();
    await accept();
    expect((await written()).calendar.error).toMatch(/isn't connected.*\/calendar\/connect/);
    vi.restoreAllMocks();
    fakeGoogle({ expired: true });
    await connect();
    await accept();
    expect((await written()).calendar.error).toMatch(/connect it again/);
  });

  it("isn't written for a day years off", async () => {
    const google = fakeGoogle();
    await connect();
    const p = await tool(assistant, "plan_propose", { date: "2099-01-05", from: 0, blocks: [block("x", 540, 600)], reasons: [{ text: "far off" }], why: {} });
    expect((await call(owner, "POST", "/api/plans/2099-01-05/accept", { version: p.version, blocks: p.proposal.blocks })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await (await call(owner, "GET", "/api/plans/2099-01-05")).json<any>()).calendar).toBeUndefined();
    expect(google.calls).toEqual([]);
  });
});
