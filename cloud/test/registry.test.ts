import { reset } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import type { Env } from "../src/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenKey } from "../src/api";
import { google, invitedToken, login, ownerToken, register, worker } from "./login";

// Who's let in (registry.ts): the admins of ADMIN_EMAILS (me@example.com in
// vitest.config.ts), anyone with an invite, and a waitlist for the rest.

const env = bindings as unknown as Env;

let admin: string;
beforeEach(async () => {
  admin = await ownerToken();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function invite(body: object = {}) {
  const res = await call(admin, "POST", "/api/admin/invites", body);
  expect(res.status).toBe(201);
  return res.json<{ code: string; uses: number | null; used: number; expires: string | null }>();
}

async function signIn(email: string, code?: string) {
  google(email);
  const r = await login({ invite: code });
  vi.restoreAllMocks();
  return r;
}

const accounts = async () => (await call(admin, "GET", "/api/admin/users")).json<any[]>();

describe("signing up", () => {
  it("lets the admins in as admins", async () => {
    expect(await accounts()).toEqual([expect.objectContaining({ email: "me@example.com", role: "admin", status: "active" })]);
    const me = await (await call(admin, "GET", "/api/me")).json<any>();
    expect(me).toMatchObject({ email: "me@example.com", name: "me", role: "admin", features: { git: true, admin: true, calendar: false } });
  });

  it("puts anyone without an invite on the waitlist, and lets them in once an admin says", async () => {
    const r = await signIn("you@example.com");
    expect(r.status).toBe(403);
    expect(r.body).toContain("waitlist");
    const you = (await accounts()).find((a) => a.email === "you@example.com");
    expect(you).toMatchObject({ role: "user", status: "waitlisted" });
    expect((await call(admin, "PATCH", `/api/admin/users/${you.sub}`, { status: "active" })).status).toBe(200);
    expect((await signIn("you@example.com")).tokens?.access_token).toBeTruthy();
  });

  it("lets someone in with an invite, once for a single-use one", async () => {
    const i = await invite();
    expect(i).toMatchObject({ uses: 1, used: 0, expires: null });
    expect((await signIn("you@example.com", i.code)).tokens?.access_token).toBeTruthy();
    const them = await signIn("them@example.com", i.code);
    expect(them.status).toBe(403);
    expect(them.body).toContain("used up");
    expect((await call(admin, "GET", "/api/admin/invites")).json()).resolves.toEqual([expect.objectContaining({ code: i.code, used: 1 })]);
    expect((await accounts()).find((a) => a.email === "you@example.com")).toMatchObject({ status: "active", invite: i.code });
  });

  it("lets in as many as a multi-use invite says, and none with an expired or revoked one", async () => {
    const many = await invite({ uses: null, label: "friends" });
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) expect((await signIn(e, many.code)).tokens).toBeTruthy();
    const old = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).mintInvite({ label: "", uses: 5, expires: "2020-01-01T00:00:00Z", by: "me@example.com" });
    expect((await signIn("late@x.com", old.code)).body).toContain("expired");
    const withdrawn = await invite({ uses: 5 });
    expect((await call(admin, "DELETE", `/api/admin/invites/${withdrawn.code}`)).status).toBe(200);
    expect((await signIn("late@x.com", withdrawn.code)).body).toContain("withdrawn");
    expect((await signIn("late@x.com", "no-such-code")).body).toContain("isn't one of ours");
  });

  it("carries the invite through the portal's sign-in, which has no consent page", async () => {
    const i = await invite();
    const clientId = await register("https://corkboard.test/");
    const q = { response_type: "code", client_id: clientId, redirect_uri: "https://corkboard.test/", scope: "owner", state: "s", code_challenge: "c".repeat(43), code_challenge_method: "S256", invite: i.code };
    const res = await worker(`/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin).toBe("https://accounts.google.com");
    google("you@example.com");
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const back = await worker(`/callback?code=g&state=${to.searchParams.get("state")}`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get("Location")!).searchParams.get("code")).toBeTruthy();
  });

  it("checks the invite's shape before it's carried", async () => {
    expect((await call(admin, "POST", "/api/admin/invites", { uses: 0 })).status).toBe(400);
    expect((await call(admin, "POST", "/api/admin/invites", { expires_in: -1 })).status).toBe(400);
    expect((await call(admin, "POST", "/api/admin/invites", { colour: "red" })).status).toBe(400);
  });
});

describe("a disabled account", () => {
  it("is refused on every token's use, and at sign-in", async () => {
    const you = await invitedToken(admin);
    expect((await call(you, "GET", "/api/boards")).status).toBe(200);
    const sub = (await accounts()).find((a) => a.email === "you@example.com").sub;
    expect((await call(admin, "PATCH", `/api/admin/users/${sub}`, { status: "disabled" })).status).toBe(200);
    expect((await call(you, "GET", "/api/boards")).status).toBe(403);
    expect((await call(you, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    expect((await call(you, "GET", "/memory/context")).status).toBe(403);
    const again = await signIn("you@example.com");
    expect(again.status).toBe(403);
    expect(again.body).toContain("can't use this corkboard");
    expect((await call(admin, "PATCH", `/api/admin/users/${sub}`, { status: "active" })).status).toBe(200);
    expect((await call(you, "GET", "/api/boards")).status).toBe(200);
  });
});

describe("the admin routes", () => {
  it("are for admins only, not users nor machine tokens", async () => {
    const you = await invitedToken(admin);
    for (const [method, path] of [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/invites"],
      ["POST", "/api/admin/invites"],
    ])
      expect((await call(you, method, path, method === "POST" ? {} : undefined)).status).toBe(403);
    const machine = (await (await call(admin, "POST", "/api/tokens/machine", { environment: "droplet" })).json<any>()).token;
    expect((await call(machine, "GET", "/api/admin/users")).status).toBe(403);
  });

  it("can't change an ADMIN_EMAILS account, or your own", async () => {
    const me = (await accounts())[0];
    expect((await call(admin, "PATCH", `/api/admin/users/${me.sub}`, { status: "disabled" })).status).toBe(409);
    const you = await invitedToken(admin);
    const sub = (await accounts()).find((a) => a.email === "you@example.com").sub;
    expect((await call(admin, "PATCH", `/api/admin/users/${sub}`, { role: "admin" })).status).toBe(200);
    // Now an admin, they can't demote themselves.
    expect((await call(you, "PATCH", `/api/admin/users/${sub}`, { role: "user" })).status).toBe(409);
    expect((await call(admin, "PATCH", `/api/admin/users/${sub}`, { role: "root" })).status).toBe(400);
  });
});

describe("an account from before the registry", () => {
  it("is let in on its token if it's an admin's, with its zone and calendar from env", async () => {
    const machine = "cbc_from-before";
    await env.OAUTH_KV.put(await tokenKey(machine), JSON.stringify({ userId: "old-sub", email: "me@example.com", grant: { kind: "machine", environment: "droplet", agent: "droplet" } }));
    expect((await call(machine, "GET", "/api/boards")).status).toBe(200);
    const users = env.USER.get(env.USER.idFromName("old-sub"));
    expect(await users.settings()).toEqual({ timezone: "America/Phoenix", name: null, calendar: "claude@group.calendar.google.com" });
    // Its machine token joins the list on that use.
    expect(await users.machineTokens()).toEqual([expect.objectContaining({ environment: "droplet", created: null, used: expect.any(String) })]);
  });

  it("isn't, for anyone else", async () => {
    const card = "cbc_someone-else";
    await env.OAUTH_KV.put(await tokenKey(card), JSON.stringify({ userId: "other-sub", email: "other@example.com", grant: { kind: "machine", environment: "x", agent: "x" } }));
    expect((await call(card, "GET", "/api/boards")).status).toBe(403);
  });
});

describe("your settings", () => {
  it("are read and changed at /api/me", async () => {
    const you = await invitedToken(admin);
    const me = await (await call(you, "GET", "/api/me")).json<any>();
    expect(me).toMatchObject({ email: "you@example.com", role: "user", settings: { timezone: "UTC", name: "you", calendar: null }, features: { git: false, admin: false } });
    expect((await call(you, "PATCH", "/api/me", { timezone: "Mars/Olympus" })).status).toBe(400);
    const changed = await (await call(you, "PATCH", "/api/me", { timezone: "Europe/Paris", name: "Yu" })).json<any>();
    expect(changed).toMatchObject({ name: "Yu", settings: { timezone: "Europe/Paris", name: "Yu" } });
    expect((await call(you, "POST", "/api/chat", { text: "hi" })).json()).resolves.toMatchObject({ who: "Yu", by_user: true });
  });
});
