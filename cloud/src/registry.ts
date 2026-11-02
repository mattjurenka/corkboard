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
//   GET    /api/admin/e2ee               every end-to-end encrypted account (e2ee.ts)
//   PATCH  /api/admin/e2ee/:id           { status }: disabling one ends its devices' tokens
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

  // End-to-end encrypted accounts (e2ee.ts) -----------------------------------------
  //
  // Known by their account key, not a Google sub, and let in the same way: an
  // invite, or an admin making one. What's kept is only what the relay
  // needs to say yes or no: the account, its revocations (signed, so its
  // devices can check them), the sign-in challenges in flight, and tokens'
  // hashes.

  private e2eeSchema = false;
  private e2ee() {
    if (this.e2eeSchema) return;
    this.sql.exec(E2EE_SCHEMA);
    this.e2eeSchema = true;
  }

  e2eeAccount(id: string): E2eeAccount | undefined {
    this.e2ee();
    const row = this.sql.exec("SELECT doc FROM e2ee_accounts WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.doc as string) as E2eeAccount) : undefined;
  }

  e2eeAccounts(): E2eeAccount[] {
    this.e2ee();
    return this.sql
      .exec("SELECT doc FROM e2ee_accounts")
      .toArray()
      .map((r) => JSON.parse(r.doc as string) as E2eeAccount)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  // by: the admin who made it, when one did; otherwise the invite pays.
  createE2ee(f: { id: string; box: string; invite: string | null; by: string | null }): Result<E2eeAccount> & { problem?: InviteProblem } {
    this.e2ee();
    if (this.e2eeAccount(f.id)) return { ok: false, status: 409, error: "that account already exists" };
    let invite: string | null = null;
    if (!f.by) {
      if (!f.invite) return { ok: false, status: 403, error: "an invite is needed to make an account" };
      const r = this.redeem(f.invite);
      if (typeof r === "string") return { ok: false, status: 403, error: `that invite is ${r === "unknown" ? "not one of ours" : r}`, problem: r };
      invite = r.code;
    }
    const a: E2eeAccount = { id: f.id, box: f.box, status: "active", created: now(), invite, by: f.by };
    this.sql.exec("INSERT INTO e2ee_accounts (id, doc) VALUES (?, ?)", a.id, JSON.stringify(a));
    return { ok: true, value: a };
  }

  setE2eeStatus(id: string, status: Status): Result<E2eeAccount> {
    const a = this.e2eeAccount(id);
    if (!a) return { ok: false, status: 404, error: `no account ${id}` };
    const b = { ...a, status };
    this.sql.exec("UPDATE e2ee_accounts SET doc = ? WHERE id = ?", JSON.stringify(b), id);
    if (status !== "active") this.sql.exec("DELETE FROM e2ee_tokens WHERE account = ?", id);
    return { ok: true, value: b };
  }

  e2eeChallenge(account: string, device: string, nonce: string, ttl: number): number {
    this.e2ee();
    const expires = Date.now() + ttl;
    this.sql.exec("DELETE FROM e2ee_challenges WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO e2ee_challenges (nonce, account, device, expires) VALUES (?, ?, ?, ?)", nonce, account, device, expires);
    return expires;
  }

  // Once only, and only for whom it was made.
  takeE2eeChallenge(nonce: string, account: string, device: string): boolean {
    this.e2ee();
    const row = this.sql.exec("DELETE FROM e2ee_challenges WHERE nonce = ? RETURNING account, device, expires", nonce).toArray()[0];
    return !!row && row.account === account && row.device === device && (row.expires as number) >= Date.now();
  }

  e2eeRevocations(account: string): { body: unknown; sig: string }[] {
    this.e2ee();
    return this.sql
      .exec("SELECT doc FROM e2ee_revoked WHERE account = ? ORDER BY at", account)
      .toArray()
      .map((r) => JSON.parse(r.doc as string));
  }

  isRevoked(account: string, device: string): boolean {
    this.e2ee();
    return this.sql.exec("SELECT 1 FROM e2ee_revoked WHERE account = ? AND device = ?", account, device).toArray().length > 0;
  }

  // The revocation's signature was checked by the caller; its device's tokens go with it.
  revokeE2ee(account: string, device: string, at: number, doc: string) {
    this.e2ee();
    this.sql.exec("INSERT INTO e2ee_revoked (account, device, at, doc) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", account, device, at, doc);
    this.sql.exec("DELETE FROM e2ee_tokens WHERE account = ? AND device = ?", account, device);
  }

  mintE2eeToken(hash: string, account: string, device: string, expires: number) {
    this.e2ee();
    this.sql.exec("DELETE FROM e2ee_tokens WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO e2ee_tokens (hash, account, device, expires) VALUES (?, ?, ?, ?)", hash, account, device, expires);
  }

  // A token's device, while the token, the device and the account are all good.
  e2eeToken(hash: string): { account: string; device: string; expires: number } | undefined {
    this.e2ee();
    const row = this.sql.exec("SELECT account, device, expires FROM e2ee_tokens WHERE hash = ?", hash).toArray()[0];
    if (!row || (row.expires as number) < Date.now()) return;
    const account = row.account as string;
    if (this.e2eeAccount(account)?.status !== "active" || this.isRevoked(account, row.device as string)) return;
    return { account, device: row.device as string, expires: row.expires as number };
  }
}

const E2EE_SCHEMA = `
CREATE TABLE IF NOT EXISTS e2ee_accounts (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS e2ee_revoked (account TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (account, device));
CREATE TABLE IF NOT EXISTS e2ee_challenges (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, device TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS e2ee_tokens (hash TEXT PRIMARY KEY, account TEXT NOT NULL, device TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS e2ee_tokens_device ON e2ee_tokens (account, device);
`;

export type E2eeAccount = {
  // The account's signing key, base64url.
  id: string;
  // Its box key, for what's wrapped to the account.
  box: string;
  status: Status;
  created: string;
  invite: string | null;
  by: string | null;
};

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
  const m = url.pathname.match(/^\/api\/admin\/(users|invites|e2ee)(?:\/([^/]+))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, what, raw] = m;
  const id = raw && decodeURIComponent(raw);
  if (what === "e2ee") {
    if (!id) return method === "GET" ? json(await r.e2eeAccounts()) : json({ error: "method not allowed" }, 405);
    if (method !== "PATCH") return json({ error: "method not allowed" }, 405);
    const { status, ...rest } = await body();
    if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
    if (!STATUSES.includes(status as Status)) throw new Invalid(`status must be one of ${STATUSES.join(", ")}`);
    const changed = (await r.setE2eeStatus(id, status as Status)) as Result<E2eeAccount>;
    return changed.ok ? json(changed.value) : json({ error: changed.error }, changed.status);
  }
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
