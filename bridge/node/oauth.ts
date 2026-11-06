// The node's own OAuth 2.1 authorization server, for /mcp and the phone's
// API, as MCP's authorization spec has it and claude.ai needs it (the
// plan's "Settled: claude.ai and the node"):
//
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728: the resource is <origin>/mcp
//   /.well-known/oauth-authorization-server       RFC 8414
//   POST /register                                 dynamic client registration (RFC 7591)
//   GET/POST /authorize                            the code flow, PKCE S256 only, with consent
//   POST /token                                    authorization_code and refresh_token
//
// A client is registered, or is a client id metadata document: an https
// client_id whose document this fetches (from a public address only) and
// checks. Consent is proof of owning the node: an approval code, made by
// `corkboard-bridge e2ee approve-connector` (or printed by `serve` as it
// starts), one use, ten minutes. Wrong codes are counted, and past a few the
// page takes none for a while.
//
// Everything is kept in <state>/node/oauth.json, tokens and codes by their
// SHA-256 only. The file is read afresh for each lookup and change, so
// `serve token` and `e2ee approve-connector`, which are other processes,
// take effect at once.
//
// What lasts (clients, grants, refresh tokens and minted ones) is the
// account's, so a client signed in on one node is on all of them: the
// running node gives it to the account's "oauth" object (Shared, serve.ts)
// and takes what the others gave. Codes, approvals and hourly access tokens
// stay on the node; a client whose node changed gets a 401 and refreshes.
// The file says which records it has shared, so a row gone from it was
// deleted here (a revoke, a rotation, an expiry) and is cleared for all,
// and one cleared elsewhere goes from it; a shared one is never given again.

import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { random } from "../../lib/e2ee/keys";
import type { CardChange } from "../../lib/e2ee/merge";
import { b64url } from "../../lib/e2ee/wire";
import { SEP } from "./objects";

export const SCOPES = ["assistant", "owner"] as const;
export type Scope = (typeof SCOPES)[number];
// A grant's kind: an OAuth scope, or held to one board (mcp.ts) as the
// Worker's are: `card`, one agent on one card (corkboard's agents.lua
// asks for it), and `session`, a fleet session's, which has no card.
export type Kind = Scope | "card" | "session";
export const boardBound = (c: { scope: Kind }) => c.scope === "card" || c.scope === "session";
// A card grant's life, as the Worker's card tokens': revoked when the agent exits.
const BOUND_DAYS = 7;

const ACCESS_TTL = 3600_000;
const REFRESH_IDLE = 30 * 24 * 3600_000;
const CODE_TTL = 10 * 60_000;
const APPROVAL_TTL = 10 * 60_000;
const CONSENT_TTL = 10 * 60_000;
const MAX_CLIENTS = 100;
// Wrong approval codes: this many in the window, and the page takes none until it's past.
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 15 * 60_000;

type Client = {
  id: string;
  name: string;
  redirect_uris: string[];
  auth: "none" | "client_secret_post" | "client_secret_basic";
  secret?: string; // its hash
  created: number;
  used?: number;
};
// A minted grant may be a brain's (`brain`): its agent, whose memory is that
// brain's, goals and all. One held to a board names it, its card or spawn and
// its agent, and goes when it expires (every node drops it then, so none
// drops it early for a token it hasn't heard of yet).
type Grant = {
  id: string;
  client: string;
  name: string;
  scope: Kind;
  resource: string | null;
  created: number;
  brain?: string;
  board?: string;
  card?: string;
  spawn?: string;
  agent?: string;
  expires?: number;
};
type CodeRow = { grant: Grant; redirect_uri: string; challenge: string; expires: number };
type TokenRow = { grant: string; kind: "access" | "refresh"; expires: number };
type File = {
  v: 1;
  clients: Record<string, Client>;
  grants: Record<string, Grant>;
  codes: Record<string, CodeRow>;
  tokens: Record<string, TokenRow>;
  approvals: { hash: string; expires: number }[];
  // The record ids of what's been given to or taken from the account.
  shared?: string[];
};

// The account's "oauth" object: its records, each `row` a client, a grant
// or a token (null, cleared), and a way to change them.
export type Shared = { cards(): { id: string; row?: unknown }[]; change(...c: CardChange[]): void };

const recordId = (type: "client" | "grant" | "token", id: string) => `${type}${SEP}${type === "token" ? Buffer.from(id, "hex").toString("base64url") : id}`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = (prefix: string) => prefix + b64url(random(32));

// A code to type: eight of Crockford's base32, shown XXXX-XXXX (40 bits).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const typed = (s: string) => s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Caller = { scope: Kind; agent: string; grant: string; resource: string | null; brain?: string; board?: string; card?: string };

export class OAuthStore {
  private failures: number[] = [];
  private documents = new Map<string, { client: Client; until: number }>();

  // Cleared here and not yet in the object: not to be taken back meanwhile.
  private clearing = new Set<string>();

  constructor(
    readonly path: string,
    private shared?: Shared,
  ) {}

  private read(): File {
    let f: File;
    try {
      f = JSON.parse(readFileSync(this.path, "utf8")) as File;
    } catch {
      f = { v: 1, clients: {}, grants: {}, codes: {}, tokens: {}, approvals: [] };
    }
    if (this.share(f)) this.save(f);
    return f;
  }

  private write(f: File) {
    const t = Date.now();
    for (const [k, c] of Object.entries(f.codes)) if (c.expires < t) delete f.codes[k];
    for (const [k, r] of Object.entries(f.tokens)) if (r.expires < t) delete f.tokens[k];
    for (const [k, g] of Object.entries(f.grants)) if (g.expires !== undefined && g.expires < t) delete f.grants[k];
    f.approvals = f.approvals.filter((a) => a.expires > t);
    this.share(f);
    this.save(f);
  }

  // The file's lasting rows and the account's, made the same; whether the
  // file changed.
  private share(f: File): boolean {
    if (!this.shared) return false;
    const known = new Set(f.shared ?? []);
    const live = new Map<string, unknown>();
    const gone = new Set<string>();
    for (const c of this.shared.cards()) {
      if (!/^(client|grant|token)\W/.test(c.id)) continue;
      if (c.row === null || c.row === undefined) gone.add(c.id);
      else live.set(c.id, c.row);
    }
    for (const id of gone) this.clearing.delete(id);
    // The file's: each record id, and how it goes.
    const t = Date.now();
    const ours = new Map<string, { row: unknown; drop: () => void }>();
    for (const [id, c] of Object.entries(f.clients)) ours.set(recordId("client", id), { row: c, drop: () => delete f.clients[id] });
    for (const [id, g] of Object.entries(f.grants)) ours.set(recordId("grant", id), { row: g, drop: () => delete f.grants[id] });
    for (const [hash, r] of Object.entries(f.tokens))
      if (r.expires > t && (r.kind === "refresh" || f.grants[r.grant]?.client === "cli")) ours.set(recordId("token", hash), { row: r, drop: () => delete f.tokens[hash] });
    const changes: CardChange[] = [];
    const set = (id: string, row: unknown) => changes.push({ t: "card", card: id, set: { row } });
    let changed = false;
    for (const [id, o] of ours) {
      if (gone.has(id)) {
        o.drop();
        known.delete(id);
        changed = true;
      } else if (!known.has(id)) {
        if (!live.has(id)) set(id, o.row);
        known.add(id);
        changed = true;
      }
    }
    for (const [id, row] of live) {
      if (ours.has(id) || this.clearing.has(id)) continue;
      if (known.has(id)) {
        set(id, null);
        this.clearing.add(id);
        known.delete(id);
      } else {
        const [type, key] = [id.slice(0, id.indexOf(SEP)), id.slice(id.indexOf(SEP) + 1)];
        if (type === "client") f.clients[key] = row as Client;
        else if (type === "grant") f.grants[key] = row as Grant;
        else f.tokens[Buffer.from(key, "base64url").toString("hex")] = row as TokenRow;
        known.add(id);
      }
      changed = true;
    }
    for (const id of known) if (gone.has(id)) known.delete(id);
    f.shared = [...known];
    if (changes.length) this.shared.change(...changes);
    return changed;
  }

  private save(f: File) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  // Written even when fn throws, so a code spent on a failed exchange stays spent.
  private change<T>(fn: (f: File) => T): T {
    const f = this.read();
    try {
      return fn(f);
    } finally {
      this.write(f);
    }
  }

  // Approval codes ----------------------------------------------------------------

  newApproval(): string {
    let code = "";
    for (const b of random(8)) code += ALPHABET[b & 31];
    this.change((f) => f.approvals.push({ hash: sha(code), expires: Date.now() + APPROVAL_TTL }));
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  // Spends the code if it's a good one. Every stored hash is compared, in
  // constant time, so how long this takes says nothing about which.
  spendApproval(input: string): boolean {
    const t = Date.now();
    this.failures = this.failures.filter((at) => at > t - FAILURE_WINDOW);
    if (this.failures.length >= MAX_FAILURES) throw new OAuthError("temporarily_unavailable", "too many wrong codes; wait a few minutes and make a new one", 429);
    const given = Buffer.from(sha(typed(input)), "hex");
    const f = this.read();
    let hit = -1;
    f.approvals.forEach((a, i) => {
      if (timingSafeEqual(given, Buffer.from(a.hash, "hex")) && a.expires > t) hit = i;
    });
    if (hit < 0) {
      this.failures.push(t);
      return false;
    }
    f.approvals.splice(hit, 1);
    this.write(f);
    return true;
  }

  // Clients -----------------------------------------------------------------------

  register(body: Record<string, unknown>): Record<string, unknown> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && redirectAllowed(u)))
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https, loopback http or an app's own scheme");
    const auth = (body.token_endpoint_auth_method ?? "client_secret_basic") as Client["auth"];
    if (!["none", "client_secret_post", "client_secret_basic"].includes(auth)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method ${auth} isn't one`);
    for (const g of (body.grant_types as string[] | undefined) ?? [])
      if (!["authorization_code", "refresh_token"].includes(g)) throw new OAuthError("invalid_client_metadata", `grant type ${g} isn't one`);
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "an unnamed client";
    const secret = auth === "none" ? undefined : newToken("cbs_");
    const client: Client = { id: `cbn-${b64url(random(12))}`, name, redirect_uris: uris as string[], auth, ...(secret ? { secret: sha(secret) } : {}), created: Date.now() };
    this.change((f) => {
      const all = Object.values(f.clients);
      // Past the cap, the oldest never used goes; registering is open to anyone.
      if (all.length >= MAX_CLIENTS) {
        const old = all.filter((c) => !c.used).sort((a, b) => a.created - b.created)[0];
        if (!old) throw new OAuthError("invalid_client_metadata", "this node has as many clients as it keeps", 400);
        delete f.clients[old.id];
      }
      f.clients[client.id] = client;
    });
    return {
      client_id: client.id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(client.created / 1000),
      client_name: name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: auth,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  async client(id: string): Promise<Client> {
    if (/^https:\/\//.test(id)) return this.document(id);
    const c = this.read().clients[id];
    if (!c) throw new OAuthError("invalid_client", `no client ${id}`, 401);
    return c;
  }

  // A client id metadata document: fetched from a public address, without
  // following redirects, in ten seconds, and kept an hour.
  private async document(id: string): Promise<Client> {
    const kept = this.documents.get(id);
    if (kept && kept.until > Date.now()) return kept.client;
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      throw new OAuthError("invalid_client", "client_id isn't a URL");
    }
    if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) throw new OAuthError("invalid_client", "a client id document is an https URL with a path");
    await publicHost(url.hostname);
    let doc: Record<string, unknown>;
    try {
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      if (text.length > 64 * 1024) throw new Error("too big");
      doc = JSON.parse(text);
    } catch (e) {
      throw new OAuthError("invalid_client", `couldn't read the client's metadata document (${(e as Error).message})`);
    }
    if (doc.client_id !== id) throw new OAuthError("invalid_client", "the metadata document names another client_id");
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && redirectAllowed(u))) throw new OAuthError("invalid_client", "the metadata document's redirect_uris aren't ones this takes");
    const auth = doc.token_endpoint_auth_method ?? "none";
    if (auth !== "none") throw new OAuthError("invalid_client", "a client id document's client authenticates with none");
    const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : url.hostname;
    const client: Client = { id, name, redirect_uris: uris as string[], auth: "none", created: Date.now() };
    this.documents.set(id, { client, until: Date.now() + 3600_000 });
    return client;
  }

  private authenticate(c: Client, secret: string | undefined) {
    if (c.auth === "none") return;
    if (!secret || !c.secret || !timingSafeEqual(Buffer.from(sha(secret), "hex"), Buffer.from(c.secret, "hex"))) throw new OAuthError("invalid_client", "the client's secret is wrong", 401);
  }

  // Authorizing -------------------------------------------------------------------

  // What /authorize was asked, checked: anything wrong before the redirect
  // URI is known to be the client's is the page's to show, not a redirect.
  async request(p: URLSearchParams, origin: string): Promise<Consent> {
    const client = await this.client(p.get("client_id") ?? "");
    const asked = p.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
    if (!client.redirect_uris.some((r) => sameRedirect(r, asked))) throw new OAuthError("invalid_request", "redirect_uri isn't one of the client's");
    const consent: Consent = { client, redirect_uri: asked, state: p.get("state"), challenge: "", scope: "assistant", resource: null, made: Date.now() };
    const fail = (code: string, why: string) => {
      throw new Redirect(errorUrl(consent, code, why, origin));
    };
    if (p.get("response_type") !== "code") fail("unsupported_response_type", "response_type must be code");
    const challenge = p.get("code_challenge") ?? "";
    if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail("invalid_request", "PKCE with S256 is required");
    consent.challenge = challenge;
    const scopes = (p.get("scope") ?? "").split(/\s+/).filter(Boolean);
    const unknown = scopes.find((s) => !(SCOPES as readonly string[]).includes(s));
    if (unknown) fail("invalid_scope", `no scope ${unknown}`);
    consent.scope = scopes.includes("owner") ? "owner" : "assistant";
    const resource = p.get("resource");
    if (resource !== null && !ours(resource, origin)) fail("invalid_target", "resource isn't this node's");
    consent.resource = resource;
    return consent;
  }

  // The client's code, once the person approved.
  approve(c: Consent, origin: string): string {
    const code = newToken("cbo_");
    const grant: Grant = { id: b64url(random(12)), client: c.client.id, name: c.client.name, scope: c.scope, resource: c.resource, created: Date.now() };
    this.change((f) => {
      f.codes[sha(code)] = { grant, redirect_uri: c.redirect_uri, challenge: c.challenge, expires: Date.now() + CODE_TTL };
      if (f.clients[c.client.id]) f.clients[c.client.id].used = Date.now();
    });
    const url = new URL(c.redirect_uri);
    url.searchParams.set("code", code);
    if (c.state !== null) url.searchParams.set("state", c.state);
    url.searchParams.set("iss", origin);
    return url.toString();
  }

  // Tokens ------------------------------------------------------------------------

  private issue(f: File, grant: Grant) {
    const access = newToken("cbn_");
    const refresh = newToken("cbr_");
    f.tokens[sha(access)] = { grant: grant.id, kind: "access", expires: Date.now() + ACCESS_TTL };
    f.tokens[sha(refresh)] = { grant: grant.id, kind: "refresh", expires: Date.now() + REFRESH_IDLE };
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: grant.scope };
  }

  async token(p: URLSearchParams, basic: { id: string; secret: string } | undefined, origin: string) {
    const clientId = basic?.id ?? p.get("client_id") ?? "";
    const client = await this.client(clientId);
    this.authenticate(client, basic?.secret ?? p.get("client_secret") ?? undefined);
    const resource = p.get("resource");
    if (resource !== null && !ours(resource, origin)) throw new OAuthError("invalid_target", "resource isn't this node's");
    const grantType = p.get("grant_type");
    if (grantType === "authorization_code") {
      const code = p.get("code") ?? "";
      return this.change((f) => {
        const row = f.codes[sha(code)];
        // Spent either way: a code is good once.
        delete f.codes[sha(code)];
        if (!row || row.expires < Date.now() || row.grant.client !== client.id) throw new OAuthError("invalid_grant", "the code is wrong, used or expired");
        if (p.get("redirect_uri") !== null && p.get("redirect_uri") !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri isn't the one the code was given to");
        const verifier = p.get("code_verifier") ?? "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash("sha256").update(verifier).digest()) !== row.challenge)
          throw new OAuthError("invalid_grant", "code_verifier doesn't match the challenge");
        if (resource !== null && row.grant.resource !== null && resource !== row.grant.resource) throw new OAuthError("invalid_target", "resource isn't the one authorized");
        const grant = { ...row.grant, resource: row.grant.resource ?? resource };
        f.grants[grant.id] = grant;
        return this.issue(f, grant);
      });
    }
    if (grantType === "refresh_token") {
      const refresh = p.get("refresh_token") ?? "";
      return this.change((f) => {
        const row = f.tokens[sha(refresh)];
        const grant = row && f.grants[row.grant];
        if (!row || row.kind !== "refresh" || row.expires < Date.now() || !grant || grant.client !== client.id) throw new OAuthError("invalid_grant", "the refresh token is wrong, used or expired");
        if (resource !== null && grant.resource !== null && resource !== grant.resource) throw new OAuthError("invalid_target", "resource isn't the one authorized");
        // Rotated: the old one is good no more.
        delete f.tokens[sha(refresh)];
        return this.issue(f, grant);
      });
    }
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  // Who a bearer is, or undefined. A token bound to a resource that isn't
  // this origin's is refused, so one minted for a name the node no longer
  // answers to isn't good under another.
  verify(bearer: string, origin: string): Caller | undefined {
    if (!bearer.startsWith("cbn_")) return;
    const f = this.read();
    const row = f.tokens[sha(bearer)];
    const grant = row && f.grants[row.grant];
    if (!row || row.kind !== "access" || row.expires < Date.now() || !grant) return;
    if (grant.resource !== null && !ours(grant.resource, origin)) return;
    return {
      scope: grant.scope,
      agent: grant.agent ?? grant.brain ?? "assistant",
      grant: grant.id,
      resource: grant.resource,
      ...(grant.brain ? { brain: grant.brain } : {}),
      ...(grant.board ? { board: grant.board } : {}),
      ...(grant.card ? { card: grant.card } : {}),
    };
  }

  // A long-lived token for a client of the user's own (the phone), made on
  // the node's own machine: no consent, since being here is the proof.
  mint(name: string, days: number, scope: Scope = "owner", brain?: string): string {
    const access = newToken("cbn_");
    this.change((f) => {
      const grant: Grant = { id: b64url(random(12)), client: "cli", name, scope, resource: null, created: Date.now(), ...(brain ? { brain } : {}) };
      f.grants[grant.id] = grant;
      f.tokens[sha(access)] = { grant: grant.id, kind: "access", expires: Date.now() + days * 86_400_000 };
    });
    return access;
  }

  // A token for one agent held to a board: a card's (agents.lua's, by
  // app.ts's token) or a fleet session's, a week unless it's revoked.
  mintBound(b: { scope: "card"; board: string; card: string; agent: string } | { scope: "session"; board: string; spawn: string; agent: string }): { token: string; expires_at: string } {
    const token = newToken("cbn_");
    const expires = Date.now() + BOUND_DAYS * 86_400_000;
    this.change((f) => {
      const grant: Grant = { id: b64url(random(12)), client: "cli", name: `${b.agent} on ${b.board}`, resource: null, created: Date.now(), expires, ...b };
      f.grants[grant.id] = grant;
      f.tokens[sha(token)] = { grant: grant.id, kind: "access", expires };
    });
    return { token, expires_at: new Date(expires).toISOString().replace(/\.\d+Z$/, "Z") };
  }

  grants(): (Grant & { tokens: number })[] {
    const f = this.read();
    return Object.values(f.grants).map((g) => ({ ...g, tokens: Object.values(f.tokens).filter((t) => t.grant === g.id).length }));
  }

  // A grant ended: its tokens with it.
  revoke(id: string): boolean {
    return this.change((f) => {
      if (!f.grants[id]) return false;
      delete f.grants[id];
      for (const [k, t] of Object.entries(f.tokens)) if (t.grant === id) delete f.tokens[k];
      return true;
    });
  }

  // A token ended, by itself (agents.lua's, as its agent exits): a grant held
  // to a board, whose only token it is, with it.
  revokeToken(token: string): boolean {
    return this.change((f) => {
      const row = f.tokens[sha(token)];
      if (!row) return false;
      delete f.tokens[sha(token)];
      if (f.grants[row.grant] && boardBound(f.grants[row.grant])) delete f.grants[row.grant];
      return true;
    });
  }
}

export type Consent = { client: Client; redirect_uri: string; state: string | null; challenge: string; scope: Scope; resource: string | null; made: number };

export class Redirect extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

function errorUrl(c: Pick<Consent, "redirect_uri" | "state">, code: string, why: string, origin: string) {
  const url = new URL(c.redirect_uri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", why);
  if (c.state !== null) url.searchParams.set("state", c.state);
  url.searchParams.set("iss", origin);
  return url.toString();
}
export const deniedUrl = (c: Consent, origin: string) => errorUrl(c, "access_denied", "the owner said no", origin);

// A resource is this node's: its origin, /mcp or /api/node, compared in
// canonical form (scheme and host's case, a default port, a trailing slash).
// Through the relay's tunnel the origin has a path, <relay>/n/<handle>,
// which the resource's must start with.
function ours(resource: string, origin: string): boolean {
  try {
    const r = new URL(resource);
    const o = new URL(origin);
    const base = o.pathname.replace(/\/$/, "");
    return !r.hash && !r.search && r.origin === o.origin && ["", "/mcp", "/api/node"].map((p) => base + p).includes(r.pathname.replace(/\/$/, ""));
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// https anywhere, http only to this machine (a CLI's loopback port), or an
// app's own scheme (app.corkboard:/oauth, RFC 8252's private-use URIs).
export function redirectAllowed(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+-]*\.[a-z0-9.+-]+:$/.test(url.protocol);
}

// Exactly, except that a loopback redirect matches on any port (RFC 8252
// 7.3): Claude Code's http://localhost/callback comes back on whatever port
// it listens on.
export function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const a = new URL(registered);
    const b = new URL(asked);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

// A host whose every address is public: not private, loopback, link-local,
// shared, multicast or reserved, so a client id can't make the node fetch
// from its own network. (Its DNS could still change between this and the
// fetch; the window is the gap the plan names.)
async function publicHost(host: string) {
  const name = host.replace(/^\[|\]$/g, "");
  const addresses = isIP(name) ? [{ address: name }] : await lookup(name, { all: true }).catch(() => []);
  if (!addresses.length) throw new OAuthError("invalid_client", `can't resolve ${host}`);
  for (const { address } of addresses) if (!publicAddress(address)) throw new OAuthError("invalid_client", `${host} isn't a public address`);
}

export function publicAddress(a: string): boolean {
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number);
    return !(
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y < 128) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y < 32) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  const v = a.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return publicAddress(mapped[1]);
  return !(v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8"));
}

