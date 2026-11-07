// Forge keys (.agent/plans/forge-keys.md): the account's word, through its
// devices, of who may do what on a forge. The gate in front of Forgejo
// (forge/gate) checks these; a device signs them.
//
// A device with a cert is the account on the forge. It can grant another
// key (a VM's device, an agent's) some of the account's repos, with a level
// per permission, the way GitHub's fine-grained tokens do; that key can
// grant a narrower part of its grant on, up to MAX_CHAIN deep. A session
// shows the whole chain: the first issuer's cert, each grant, and the last
// holder's answer to the gate's nonce.
//
// Signed bodies are flat (wire.ts's canonical), so a grant's lists travel as
// sorted, space-separated strings.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkCert, verify } from "./device";
import type { AccountKeys, KeyPair } from "./keys";
import { type DeviceCert, type Revocation, type Signed, KEY, b64url, isRevocation, revocationBytes, signed, utf8 } from "./wire";

export const MAX_CHAIN = 4;
// How far a grant's issued may be ahead of the gate's clock.
const SKEW = 5 * 60_000;

export const PERMISSIONS = ["metadata", "contents", "pull_requests", "issues", "releases", "statuses", "wiki", "administration", "webhooks"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Level = "read" | "write";

// The account binding itself to a forge user: id is its first key, which a
// rotation never changes, key its key now. by signs it: the account's key, or
// a device of the account's (its cert goes with it).
export type ForgeBind = { v: 1; origin: string; id: string; key: string; by: string; user: string; at: number };

// account: the account's id. issuer: the key that signs it, a device with a
// cert (the first grant) or the holder of parent. repos: "owner/name" or
// "owner/*", lowercased. perms: "contents:write issues:read". refs: full ref
// names or prefixes ending "/*", or null for any. del: 1 lets
// administration:write delete the repo. parent: forgeGrantHash of the grant
// this narrows, null for the first.
export type ForgeGrant = {
  v: 1;
  account: string;
  issuer: string;
  holder: string;
  name: string;
  issued: number;
  expires: number;
  repos: string;
  perms: string;
  refs: string | null;
  del: 0 | 1;
  parent: string | null;
};

// The holder (or a device, with no grant) answering the gate's nonce.
export type ForgeChallenge = { v: 1; origin: string; nonce: string; holder: string };

// A grant taken back, by the account's key or by the grant's issuer.
export type GrantRevocation = { v: 1; account: string; grant: string; by: string; at: number };

export const forgeBindBytes = (b: ForgeBind) => signed("forge-bind", b);
export const forgeGrantBytes = (g: ForgeGrant) => signed("forge-grant", g);
export const forgeChallengeBytes = (c: ForgeChallenge) => signed("forge-challenge", c);
export const grantRevocationBytes = (r: GrantRevocation) => signed("forge-grant-revocation", r);

export const forgeGrantHash = (g: ForgeGrant) => b64url(sha256(forgeGrantBytes(g)));

const REPO = /^[\w.-]{1,100}\/([\w.-]{1,100}|\*)$/;
const REF = /^refs\/(?!.*\.\.)[\w./-]{1,200}?(\/\*)?$/;
const sign = (kp: KeyPair, bytes: Uint8Array) => b64url(ed25519.sign(bytes, kp.secret));

// What a grant allows, parsed.
export type Scope = { repos: string[]; perms: Partial<Record<Permission, Level>>; refs: string[] | null; del: boolean; expires: number };

export type GrantTerms = { repos: string[]; perms: Partial<Record<Permission, Level>>; refs?: string[] | null; del?: boolean; expires: number; name: string };

// A ref as a grant names it: a branch, or a full ref; "agent/*" is
// refs/heads/agent/*.
export const fullRef = (r: string) => (r.startsWith("refs/") ? r : `refs/heads/${r}`);

function encode(t: GrantTerms): Pick<ForgeGrant, "repos" | "perms" | "refs" | "del"> {
  const perms = Object.entries(t.perms)
    .filter(([p, l]) => p !== "metadata" && l)
    .map(([p, l]) => `${p}:${l}`)
    .sort();
  return {
    repos: [...new Set(t.repos.map((r) => r.toLowerCase()))].sort().join(" "),
    perms: perms.join(" "),
    refs: t.refs ? [...new Set(t.refs.map(fullRef))].sort().join(" ") : null,
    del: t.del ? 1 : 0,
  };
}

export function scopeOf(g: ForgeGrant): Scope | string {
  const repos = g.repos.split(" ").filter(Boolean);
  if (!repos.length || !repos.every((r) => REPO.test(r) && r === r.toLowerCase())) return "a grant's repos are owner/name or owner/*, lowercased";
  const perms: Scope["perms"] = { metadata: "read" };
  for (const p of g.perms.split(" ").filter(Boolean)) {
    const [name, level] = p.split(":");
    if (!PERMISSIONS.includes(name as Permission) || name === "metadata" || (level !== "read" && level !== "write")) return `not a permission: ${p}`;
    perms[name as Permission] = level;
  }
  let refs: string[] | null = null;
  if (g.refs !== null) {
    refs = g.refs.split(" ").filter(Boolean);
    if (!refs.length || !refs.every((r) => REF.test(r))) return "a grant's refs are full ref names, or prefixes ending /*";
  }
  return { repos, perms, refs, del: g.del === 1, expires: g.expires };
}

function isForgeGrant(g: unknown): g is ForgeGrant {
  const o = g as ForgeGrant;
  return (
    !!o &&
    o.v === 1 &&
    KEY.test(o.account) &&
    KEY.test(o.issuer) &&
    KEY.test(o.holder) &&
    typeof o.name === "string" &&
    o.name.length <= 100 &&
    Number.isSafeInteger(o.issued) &&
    Number.isSafeInteger(o.expires) &&
    typeof o.repos === "string" &&
    typeof o.perms === "string" &&
    (o.refs === null || typeof o.refs === "string") &&
    (o.del === 0 || o.del === 1) &&
    (o.parent === null || KEY.test(o.parent))
  );
}

// Signing --------------------------------------------------------------------

export type Signer = { id: string; sign: KeyPair };

export function bindForge(account: AccountKeys, id: string, origin: string, user: string, at = Date.now()): Signed<ForgeBind> {
  const body: ForgeBind = { v: 1, origin, id, key: account.id, by: account.id, user, at };
  return { body, sig: sign(account.sign, forgeBindBytes(body)) };
}

// The same, signed by a device with a cert: key is the account's key now.
export function bindForgeAsDevice(device: Signer, id: string, key: string, origin: string, user: string, at = Date.now()): Signed<ForgeBind> {
  const body: ForgeBind = { v: 1, origin, id, key, by: device.id, user, at };
  return { body, sig: sign(device.sign, forgeBindBytes(body)) };
}

// A grant from issuer to holder; parent is the issuer's own grant, if the
// issuer holds one rather than being a device of the account's.
export function grantForge(issuer: Signer, account: string, holder: string, terms: GrantTerms, parent?: Signed<ForgeGrant>, issued = Date.now()): Signed<ForgeGrant> {
  const body: ForgeGrant = { v: 1, account, issuer: issuer.id, holder, name: terms.name.slice(0, 100), issued, expires: terms.expires, ...encode(terms), parent: parent ? forgeGrantHash(parent.body) : null };
  return { body, sig: sign(issuer.sign, forgeGrantBytes(body)) };
}

export function answerForge(holder: Signer, origin: string, nonce: string): Signed<ForgeChallenge> {
  const body: ForgeChallenge = { v: 1, origin, nonce, holder: holder.id };
  return { body, sig: sign(holder.sign, forgeChallengeBytes(body)) };
}

// A chain shown on a sealed channel to the node's forge (bridge/node/forge.ts),
// as headers: the chain (base64url JSON), and, when it's held by a key that
// isn't the channel's device, that key's answer to channelChallenge(the
// channel's device): the same every time, and good on that device's
// channels alone.
export const CHAIN_HEADER = "x-corkboard-chain";
export const ANSWER_HEADER = "x-corkboard-answer";
export const channelChallenge = (device: string) => ({ origin: `corkboard-channel:${device}`, nonce: device });
export const channelAnswer = (holder: Signer, device: string) => {
  const c = channelChallenge(device);
  return b64url(utf8(JSON.stringify(answerForge(holder, c.origin, c.nonce))));
};

export function revokeForgeGrant(by: Signer, account: string, grant: string, at = Date.now()): Signed<GrantRevocation> {
  const body: GrantRevocation = { v: 1, account, grant, by: by.id, at };
  return { body, sig: sign(by.sign, grantRevocationBytes(body)) };
}

// Checking -------------------------------------------------------------------

const covers = (parent: string, child: string) => {
  if (parent === child) return true;
  if (!parent.endsWith("/*")) return false;
  const prefix = parent.slice(0, -1);
  return child.startsWith(prefix);
};

export function repoAllowed(s: Scope, owner: string, name: string): boolean {
  const r = `${owner}/${name}`.toLowerCase();
  return s.repos.some((p) => p === r || (p.endsWith("/*") && r.startsWith(p.slice(0, -1))));
}

export function refAllowed(s: Scope, ref: string): boolean {
  return s.refs === null || s.refs.some((p) => covers(p, ref));
}

export const atLeast = (s: Scope, p: Permission, l: Level) => s.perms[p] === "write" || (l === "read" && s.perms[p] === "read");

// Why child isn't within parent, or null if it is.
export function narrows(child: Scope, parent: Scope): string | null {
  for (const r of child.repos) {
    const [owner, name] = r.split("/");
    if (!(parent.repos.includes(r) || (name !== "*" && repoAllowed(parent, owner, name)))) return `${r} isn't in the grant it narrows`;
  }
  for (const p of PERMISSIONS) {
    const l = child.perms[p];
    if (l && !atLeast(parent, p, l)) return `${p}:${l} is more than the grant it narrows`;
  }
  if (child.refs === null ? parent.refs !== null : parent.refs !== null && !child.refs.every((r) => parent.refs!.some((p) => covers(p, r)))) return "refs wider than the grant it narrows";
  if (child.del && !parent.del) return "delete isn't in the grant it narrows";
  if (child.expires > parent.expires) return "expires after the grant it narrows";
  return null;
}

export type Chain = { cert: Signed<DeviceCert>; grants?: Signed<ForgeGrant>[] };
// What a checked chain comes to: the key that must answer, what it may do
// (null: the account itself), and every key and grant in it, for revoking.
export type Checked = { holder: string; device: string; scope: Scope | null; keys: string[]; grants: string[] };

export type Revoked = {
  devices: Iterable<Signed<Revocation>>;
  // Whether a grant, by its hash, was revoked by the account or its issuer.
  grant: (hash: string, issuer: string) => boolean;
};

const revokedKey = (key: string, account: string, rs: Iterable<Signed<Revocation>>) => {
  for (const r of rs) if (isRevocation(r.body) && r.body.account === account && r.body.device === key && verify(account, revocationBytes(r.body), r.sig)) return true;
  return false;
};

// id: the account's id; key: its key now (sharing.ts's currentKey).
export function checkChain(id: string, key: string, chain: Chain, revoked: Revoked, now = Date.now()): Checked | string {
  const devices = [...revoked.devices];
  const bad = checkCert(key, chain?.cert, devices);
  if (bad) return bad;
  const cert = chain.cert.body;
  // A relay-only device (fleetd's) holds grants; it never issues them, nor is it the account.
  if (cert.role === "relay") return "a relay-only device isn't the account; it holds a grant from one that is";
  const grants = chain.grants ?? [];
  if (!Array.isArray(grants) || grants.length > MAX_CHAIN) return `at most ${MAX_CHAIN} grants`;
  const out: Checked = { holder: cert.device, device: cert.device, scope: null, keys: [cert.device], grants: [] };
  let parentHash: string | null = null;
  for (let i = 0; i < grants.length; i++) {
    const g = grants[i];
    if (!g || !isForgeGrant(g.body) || typeof g.sig !== "string") return "not a grant";
    const b = g.body;
    if (b.account !== id) return "a grant is for another account";
    if (b.issuer !== out.holder) return "a grant's issuer isn't the key before it";
    if (b.parent !== parentHash) return "a grant doesn't name the grant before it";
    if (!verify(b.issuer, forgeGrantBytes(b), g.sig)) return "a grant isn't signed by its issuer";
    if (b.issued > now + SKEW) return "a grant is issued in the future";
    if (b.expires <= now) return "a grant has expired";
    const scope = scopeOf(b);
    if (typeof scope === "string") return scope;
    if (out.scope) {
      const why = narrows(scope, out.scope);
      if (why) return why;
    }
    const hash = forgeGrantHash(b);
    if (revoked.grant(hash, b.issuer)) return "a grant is revoked";
    if (revokedKey(b.holder, key, devices)) return "a grant's holder is revoked";
    out.scope = scope;
    out.holder = b.holder;
    out.keys.push(b.holder);
    out.grants.push(hash);
    parentHash = hash;
  }
  return out;
}

export function checkAnswer(a: Signed<ForgeChallenge>, origin: string, nonce: string, holder: string): string | null {
  const b = a?.body;
  if (!b || b.v !== 1 || b.origin !== origin || b.nonce !== nonce || b.holder !== holder || typeof a.sig !== "string") return "the answer isn't to this challenge, by the chain's holder";
  return verify(holder, forgeChallengeBytes(b), a.sig) ? null : "the answer isn't signed by the chain's holder";
}

export function checkBind(b: Signed<ForgeBind>, origin: string): string | null {
  const o = b?.body;
  if (!o || o.v !== 1 || o.origin !== origin || !KEY.test(o.id) || !KEY.test(o.key) || !KEY.test(o.by) || typeof o.user !== "string" || !/^[\w.-]{1,40}$/.test(o.user) || !Number.isSafeInteger(o.at)) return "not a binding to this forge";
  return verify(o.by, forgeBindBytes(o), b.sig) ? null : "the binding isn't signed by its key";
}

export function checkGrantRevocation(r: Signed<GrantRevocation>): string | null {
  const o = r?.body;
  if (!o || o.v !== 1 || !KEY.test(o.account) || !KEY.test(o.grant) || !KEY.test(o.by) || !Number.isSafeInteger(o.at)) return "not a grant revocation";
  return verify(o.by, grantRevocationBytes(o), r.sig) ? null : "the revocation isn't signed by its key";
}
export const FORGE_BIND_SSH = "corkboard-forge-bind"; // the namespace of an SSH key's signature over a binding
