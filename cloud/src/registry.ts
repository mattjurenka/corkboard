// Who may use this Worker: one object for all of it (REGISTRY, named
// "registry"), with a row for everyone who has signed in, and the invites
// that let them. Everything else stays keyed by the user's Google sub, so
// this only says whether a sub is let in, and as what.
//
// ADMIN_EMAILS (a comma list) always get in, as admins. Anyone else gets in
// with an invite an admin made (single- or multi-use, maybe expiring),
// carried through /authorize as ?invite=; without one they're recorded as
// waitlisted, and an admin can let them in later. A disabled account is
// refused on every token's use (api.ts), not only at sign-in.
//
//   GET    /api/admin/users              every account, newest first
//   PATCH  /api/admin/users/:sub         { status?, role? }
//   GET    /api/admin/invites            every invite, newest first
//   POST   /api/admin/invites            { label?, uses? (default 1, null: any number), expires_in? (seconds) }
//   DELETE /api/admin/invites/:code      revoke it; who it let in stays in
//
// Admins only, and not with a machine token (api.ts).

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./board";
import { Invalid } from "./cards";
import type { Env, Props } from "./index";

export type Role = "admin" | "user";
export type Status = "active" | "waitlisted" | "disabled";
export const ROLES: Role[] = ["admin", "user"];
export const STATUSES: Status[] = ["active", "waitlisted", "disabled"];

export type Account = {
  sub: string;
  email: string;
  name: string | null;
  role: Role;
  status: Status;
  created: string;
  // When they last signed in.
  seen: string | null;
  // The invite that let them in, if one did.
  invite: string | null;
};

export type Invite = {
  code: string;
  label: string;
  // How many it has let in, and how many it may (null: any number).
  used: number;
  uses: number | null;
  expires: string | null;
  created: string;
  by: string;
  revoked: string | null;
};

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (sub TEXT PRIMARY KEY, email TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, doc TEXT NOT NULL);
`;

// Why an invite didn't let someone in, for the waitlist page.
export type InviteProblem = "unknown" | "used" | "expired" | "revoked";

export class Registry extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  account(sub: string): Account | undefined {
    const row = this.sql.exec("SELECT doc FROM accounts WHERE sub = ?", sub).toArray()[0];
    return row ? (JSON.parse(row.doc as string) as Account) : undefined;
  }

  private save(a: Account): Account {
    this.sql.exec("INSERT INTO accounts (sub, email, doc) VALUES (?, ?, ?) ON CONFLICT (sub) DO UPDATE SET email = excluded.email, doc = excluded.doc", a.sub, a.email, JSON.stringify(a));
    return a;
  }

  accounts(): Account[] {
    return this.sql
      .exec("SELECT doc FROM accounts")
      .toArray()
      .map((r) => JSON.parse(r.doc as string) as Account)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  // A sign-in at /callback: recorded, or updated, and let in if they're an
  // admin, already in, or bring an invite that's good. created: whether
  // this is their first, for the caller to set up their settings.
  signIn(who: { sub: string; email: string; name?: string | null }, admin: boolean, invite?: string): { account: Account; created: boolean; problem?: InviteProblem } {
    const at = now();
    const had = this.account(who.sub);
    let a: Account = had
      ? { ...had, email: who.email, name: who.name ?? had.name, seen: at }
      : { sub: who.sub, email: who.email, name: who.name ?? null, role: "user", status: "waitlisted", created: at, seen: at, invite: null };
    let problem: InviteProblem | undefined;
    if (admin) a = { ...a, role: "admin", status: "active" };
    else if (a.status === "waitlisted" && invite) {
      const r = this.redeem(invite);
      if (typeof r === "string") problem = r;
      else a = { ...a, status: "active", invite: r.code };
    }
    return { account: this.save(a), created: !had, ...(problem && { problem }) };
  }

  // A token's use (api.ts): the account, or for an admin email with none
  // (signed in before there was a registry), one made now.
  check(sub: string, email: string, admin: boolean): { account: Account | null; created: boolean } {
    const had = this.account(sub);
    if (had && (!admin || (had.role === "admin" && had.status === "active"))) return { account: had, created: false };
    if (!admin) return { account: null, created: false };
    const a: Account = had
      ? { ...had, role: "admin", status: "active" }
      : { sub, email, name: null, role: "admin", status: "active", created: now(), seen: null, invite: null };
    return { account: this.save(a), created: !had };
  }

  setAccount(sub: string, f: { role?: Role; status?: Status }): Result<Account> {
    const a = this.account(sub);
    if (!a) return { ok: false, status: 404, error: `no account ${sub}` };
    return { ok: true, value: this.save({ ...a, ...f }) };
  }

  // Invites -------------------------------------------------------------------------

  invite(code: string): Invite | undefined {
    const row = this.sql.exec("SELECT doc FROM invites WHERE code = ?", code).toArray()[0];
    return row ? (JSON.parse(row.doc as string) as Invite) : undefined;
  }

  private saveInvite(i: Invite): Invite {
    this.sql.exec("INSERT INTO invites (code, doc) VALUES (?, ?) ON CONFLICT (code) DO UPDATE SET doc = excluded.doc", i.code, JSON.stringify(i));
    return i;
  }

  invites(): Invite[] {
    return this.sql
      .exec("SELECT doc FROM invites")
      .toArray()
      .map((r) => JSON.parse(r.doc as string) as Invite)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  mintInvite(f: { label: string; uses: number | null; expires: string | null; by: string }): Invite {
    const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, "-").replace(/\//g, "_");
    return this.saveInvite({ code, ...f, used: 0, created: now(), revoked: null });
  }

  revokeInvite(code: string): Result<Invite> {
    const i = this.invite(code);
    if (!i) return { ok: false, status: 404, error: `no invite ${code}` };
    return { ok: true, value: i.revoked ? i : this.saveInvite({ ...i, revoked: now() }) };
  }

  // One use of an invite, if it has one left.
  private redeem(code: string): Invite | InviteProblem {
    const i = this.invite(code);
    if (!i) return "unknown";
    if (i.revoked) return "revoked";
    if (i.expires && Date.parse(i.expires) <= Date.now()) return "expired";
    if (i.uses !== null && i.used >= i.uses) return "used";
    return this.saveInvite({ ...i, used: i.used + 1 });
  }
}

// The admins' addresses, lowercased.
export const admins = (env: Env): string[] =>
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// The address this Worker was first made for, whose settings start from
// TIMEZONE and CALENDAR_ID when there are any: the first of ADMIN_EMAILS.
export const isOwner = (env: Env, email: string) => admins(env)[0] === email.toLowerCase();

export const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

// A new account's settings (user.ts): the owner's from env, so an account
// from before there were settings keeps its zone and calendar; anyone
// else's from where they signed in.
export async function welcome(env: Env, sub: string, email: string, seen: { name?: string | null; timezone?: string | null } = {}) {
  const owner = isOwner(env, email);
  await env.USER.get(env.USER.idFromName(sub)).welcome({
    name: seen.name ?? null,
    timezone: (owner && env.TIMEZONE) || seen.timezone || null,
    calendar: (owner && env.CALENDAR_ID) || null,
  });
}

// Each token's use asks, so it's kept here a little while: a change an
// admin makes takes up to this long to reach every isolate.
const CACHE_MS = 30_000;
const cache = new Map<string, { account: Account | null; until: number }>();

export async function accountOf(env: Env, props: Props): Promise<Account | null> {
  const hit = cache.get(props.userId);
  if (hit && hit.until > Date.now()) return hit.account;
  const email = (props.email ?? "").toLowerCase();
  const { account, created } = await registry(env).check(props.userId, email, admins(env).includes(email));
  if (created) await welcome(env, props.userId, email);
  cache.set(props.userId, { account, until: Date.now() + CACHE_MS });
  return account;
}

export const forgetAccount = (sub: string) => cache.delete(sub);

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function adminRoutes(request: Request, env: Env, me: Account, body: () => Promise<Record<string, unknown>>): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const r = registry(env);
  const m = url.pathname.match(/^\/api\/admin\/(users|invites)(?:\/([^/]+))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, what, raw] = m;
  const id = raw && decodeURIComponent(raw);
  if (what === "users") {
    if (!id) return method === "GET" ? json(await r.accounts()) : json({ error: "method not allowed" }, 405);
    if (method !== "PATCH") return json({ error: "method not allowed" }, 405);
    const { role, status, ...rest } = await body();
    if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
    if (role !== undefined && !ROLES.includes(role as Role)) throw new Invalid(`role must be one of ${ROLES.join(", ")}`);
    if (status !== undefined && !STATUSES.includes(status as Status)) throw new Invalid(`status must be one of ${STATUSES.join(", ")}`);
    const a = await r.account(id);
    if (!a) return json({ error: `no account ${id}` }, 404);
    if (admins(env).includes(a.email)) return json({ error: `${a.email} is in ADMIN_EMAILS; change it there` }, 409);
    if (a.sub === me.sub) return json({ error: "not your own account" }, 409);
    const changed = (await r.setAccount(id, { ...(role !== undefined && { role: role as Role }), ...(status !== undefined && { status: status as Status }) })) as Result<Account>;
    forgetAccount(id);
    return changed.ok ? json(changed.value) : json({ error: changed.error }, changed.status);
  }
  if (!id) {
    if (method === "GET") return json(await r.invites());
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    const { label = "", uses = 1, expires_in = null, ...rest } = await body();
    if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
    if (typeof label !== "string" || label.length > 200) throw new Invalid("label must be a line of at most 200 characters");
    if (uses !== null && !(Number.isInteger(uses) && (uses as number) >= 1 && (uses as number) <= 10_000)) throw new Invalid("uses must be how many it lets in, 1 to 10000, or null for any number");
    if (expires_in !== null && !(Number.isInteger(expires_in) && (expires_in as number) > 0)) throw new Invalid("expires_in must be seconds from now, or null");
    const expires = expires_in === null ? null : new Date(Date.now() + (expires_in as number) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    return json(await r.mintInvite({ label: label.trim(), uses: uses as number | null, expires, by: me.email }), 201);
  }
  if (method !== "DELETE") return json({ error: "method not allowed" }, 405);
  const revoked = (await r.revokeInvite(id)) as Result<Invite>;
  return revoked.ok ? json(revoked.value) : json({ error: revoked.error }, revoked.status);
}
