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
import type { Creation, Grant, DeviceCert, Rotation, Signed } from "../../lib/e2ee/wire";

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
    return row ? e2eeDoc(row.doc as string) : undefined;
  }

  // By its id, or by the key it signs with now (after a rotation, not its id).
  e2eeAccountByKey(key: string): E2eeAccount | undefined {
    this.e2ee();
    const moved = this.sql.exec("SELECT account FROM e2ee_keys WHERE key = ?", key).toArray()[0];
    return this.e2eeAccount(moved ? (moved.account as string) : key);
  }

  e2eeAccounts(): E2eeAccount[] {
    this.e2ee();
    return this.sql
      .exec("SELECT doc FROM e2ee_accounts")
      .toArray()
      .map((r) => e2eeDoc(r.doc as string))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  // by: the admin who made it, when one did; otherwise the invite pays.
  createE2ee(f: { id: string; box: string; invite: string | null; by: string | null; creation: Signed<Creation> }): Result<E2eeAccount> & { problem?: InviteProblem } {
    this.e2ee();
    if (this.e2eeAccountByKey(f.id)) return { ok: false, status: 409, error: "that account already exists" };
    let invite: string | null = null;
    if (!f.by) {
      if (!f.invite) return { ok: false, status: 403, error: "an invite is needed to make an account" };
      const r = this.redeem(f.invite);
      if (typeof r === "string") return { ok: false, status: 403, error: `that invite is ${r === "unknown" ? "not one of ours" : r}`, problem: r };
      invite = r.code;
    }
    const a: E2eeAccount = { id: f.id, key: f.id, box: f.box, status: "active", created: now(), invite, by: f.by, creation: f.creation, rotations: [] };
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

  // The account onto a new key (e2ee.ts checked the signatures): from must
  // still be its key, and to nobody's. Every token of the account ends, and
  // each device kept gets its bundle (its new cert, the new root sealed to
  // it); one left out has nothing to fetch.
  rotateE2ee(id: string, rotation: Signed<Rotation>, bundles: { cert: Signed<DeviceCert>; root: string }[]): Result<E2eeAccount> {
    this.e2ee();
    const a = this.e2eeAccount(id);
    if (!a) return { ok: false, status: 404, error: "no such account here" };
    const r = rotation.body;
    if (r.from !== a.key) return { ok: false, status: 409, error: "the account's key has changed since: rotate from the one it has now" };
    if (this.e2eeAccountByKey(r.to) || this.sql.exec("SELECT 1 FROM e2ee_keys WHERE key = ?", r.to).toArray().length) return { ok: false, status: 409, error: "that key is taken" };
    const b: E2eeAccount = { ...a, key: r.to, box: r.box, rotations: [...a.rotations, rotation] };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE e2ee_accounts SET doc = ? WHERE id = ?", JSON.stringify(b), id);
      this.sql.exec("DELETE FROM e2ee_keys WHERE account = ?", id);
      this.sql.exec("INSERT INTO e2ee_keys (key, account) VALUES (?, ?)", r.to, id);
      this.sql.exec("DELETE FROM e2ee_tokens WHERE account = ?", id);
      this.sql.exec("DELETE FROM e2ee_rotated WHERE account = ?", id);
      for (const x of bundles) this.sql.exec("INSERT INTO e2ee_rotated (account, device, doc) VALUES (?, ?, ?)", id, x.cert.body.device, JSON.stringify(x));
    });
    return { ok: true, value: b };
  }

  // What a device kept by the last rotation fetches to follow it.
  e2eeRotated(id: string, device: string): { rotations: Signed<Rotation>[]; cert: Signed<DeviceCert>; root: string } | undefined {
    this.e2ee();
    const a = this.e2eeAccount(id);
    const row = this.sql.exec("SELECT doc FROM e2ee_rotated WHERE account = ? AND device = ?", id, device).toArray()[0];
    if (!a || !row) return;
    return { rotations: a.rotations, ...(JSON.parse(row.doc as string) as { cert: Signed<DeviceCert>; root: string }) };
  }

  // Grants (e2ee.ts checked the owner's signature and the sealed box's hash).
  // One per (owner, object, member): a newer one replaces it.
  putGrant(grant: Signed<Grant>, sealed: string, members: number): Result<{ ok: true }> {
    this.e2ee();
    const g = grant.body;
    if (g.member === g.owner) return { ok: false, status: 400, error: "an object is its owner's already" };
    if (this.e2eeAccount(g.member)?.status !== "active") return { ok: false, status: 404, error: "the member must be an active account here, by its id" };
    const had = this.sql.exec("SELECT at FROM e2ee_grants WHERE owner = ? AND object = ? AND member = ?", g.owner, g.object, g.member).toArray()[0];
    if (had && (had.at as number) > g.at) return { ok: false, status: 409, error: "there's a newer grant to that member" };
    if (!had) {
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM e2ee_grants WHERE owner = ? AND object = ?", g.owner, g.object).one().n as number;
      if (n >= members) return { ok: false, status: 413, error: `an object is shared with at most ${members} accounts` };
    }
    this.sql.exec(
      "INSERT INTO e2ee_grants (owner, object, member, role, at, doc) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, object, member) DO UPDATE SET role = excluded.role, at = excluded.at, doc = excluded.doc",
      g.owner,
      g.object,
      g.member,
      g.role,
      g.at,
      JSON.stringify({ grant, sealed }),
    );
    return { ok: true, value: { ok: true } };
  }

  dropGrant(owner: string, object: string, member?: string) {
    this.e2ee();
    if (member) this.sql.exec("DELETE FROM e2ee_grants WHERE owner = ? AND object = ? AND member = ?", owner, object, member);
    else this.sql.exec("DELETE FROM e2ee_grants WHERE owner = ? AND object = ?", owner, object);
  }

  // The role a member has on an owner's object, if any.
  grantRole(owner: string, object: string, member: string): string | undefined {
    this.e2ee();
    return this.sql.exec("SELECT role FROM e2ee_grants WHERE owner = ? AND object = ? AND member = ?", owner, object, member).toArray()[0]?.role as string | undefined;
  }

  // An object's grants (by: owner), or every grant to a member.
  grants(by: { owner: string; object: string } | { member: string }): { grant: Signed<Grant>; sealed: string }[] {
    this.e2ee();
    const rows =
      "member" in by
        ? this.sql.exec("SELECT doc FROM e2ee_grants WHERE member = ? ORDER BY at", by.member)
        : this.sql.exec("SELECT doc FROM e2ee_grants WHERE owner = ? AND object = ? ORDER BY at", by.owner, by.object);
    return rows.toArray().map((r) => JSON.parse(r.doc as string));
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
CREATE TABLE IF NOT EXISTS e2ee_keys (key TEXT PRIMARY KEY, account TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS e2ee_rotated (account TEXT NOT NULL, device TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (account, device));
CREATE TABLE IF NOT EXISTS e2ee_grants (owner TEXT NOT NULL, object TEXT NOT NULL, member TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (owner, object, member));
CREATE INDEX IF NOT EXISTS e2ee_grants_member ON e2ee_grants (member);
`;

export type E2eeAccount = {
  // The account's first signing key, base64url: its id for good.
  id: string;
  // The key it signs with now (its id until a rotation), and its box key,
  // for what's wrapped to the account.
  key: string;
  box: string;
  status: Status;
  created: string;
  invite: string | null;
  by: string | null;
  // Its signed creation, and each rotation since: the proof key and box are
  // the id's. An account made before these were kept has no creation.
  creation: Signed<Creation> | null;
  rotations: Signed<Rotation>[];
};

// An account as stored, with what an older one lacks filled in.
const e2eeDoc = (doc: string): E2eeAccount => {
  const a = JSON.parse(doc) as Partial<E2eeAccount> & { id: string; box: string };
  return { ...a, key: a.key ?? a.id, creation: a.creation ?? null, rotations: a.rotations ?? [] } as E2eeAccount;
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
