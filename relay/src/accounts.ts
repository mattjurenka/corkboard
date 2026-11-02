// The relay's accounts: known by their account key, not by any sign-in.
// What's kept is only what the relay needs to say yes or no: the account,
// its revocations (signed, so its devices can check them), the sign-in
// challenges in flight, tokens' hashes, rotations and grants.
//
// A Durable Object of its own in a relay you run (index.ts's Accounts);
// the hosted Worker's registry extends it, beside its other sign-ins. Each
// says how an account is let in (admit): an invite, checked its own way.

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./result";
import type { Creation, Grant, DeviceCert, Rotation, Signed } from "../../lib/e2ee/wire";

export type AccountStatus = "active" | "waitlisted" | "disabled";
export const ACCOUNT_STATUSES: AccountStatus[] = ["active", "waitlisted", "disabled"];

// Why an invite didn't let someone in.
export type InviteProblem = "unknown" | "used" | "expired" | "revoked";

export type E2eeAccount = {
  // The account's first signing key, base64url: its id for good.
  id: string;
  // The key it signs with now (its id until a rotation), and its box key,
  // for what's wrapped to the account.
  key: string;
  box: string;
  status: AccountStatus;
  created: string;
  invite: string | null;
  by: string | null;
  // Its signed creation, and each rotation since: the proof key and box are
  // the id's. An account made before these were kept has no creation.
  creation: Signed<Creation> | null;
  rotations: Signed<Rotation>[];
};

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export abstract class RelayAccounts extends DurableObject {
  protected sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // One use of an invite, if it lets anyone in: what to record it as.
  protected abstract admit(invite: string): { code: string } | InviteProblem;

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
      const r = this.admit(f.invite);
      if (typeof r === "string") return { ok: false, status: 403, error: `that invite is ${r === "unknown" ? "not one of ours" : r}`, problem: r };
      invite = r.code;
    }
    const a: E2eeAccount = { id: f.id, key: f.id, box: f.box, status: "active", created: now(), invite, by: f.by, creation: f.creation, rotations: [] };
    this.sql.exec("INSERT INTO e2ee_accounts (id, doc) VALUES (?, ?)", a.id, JSON.stringify(a));
    return { ok: true, value: a };
  }

  setE2eeStatus(id: string, status: AccountStatus): Result<E2eeAccount> {
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

  // The account onto a new key (routes.ts checked the signatures): from must
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

  // Grants (routes.ts checked the owner's signature and the sealed box's hash).
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

// An account as stored, with what an older one lacks filled in.
const e2eeDoc = (doc: string): E2eeAccount => {
  const a = JSON.parse(doc) as Partial<E2eeAccount> & { id: string; box: string };
  return { ...a, key: a.key ?? a.id, creation: a.creation ?? null, rotations: a.rotations ?? [] } as E2eeAccount;
};
