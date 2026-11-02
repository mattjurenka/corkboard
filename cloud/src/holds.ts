// What brains hold, as records (.agent/plans/brains.md): a hold is a name a
// brain's `credentials` or a template's (its Nix capabilities') lists, what
// it's for, and its secret, which a spawn holding it is handed at its
// claim (fleet.ts), as /mnt/share/secrets/<name> in its slot. Or, for one
// whose secret is kept elsewhere (Pepper's google, on its own VM's disk),
// where that is. Holding any still makes an agent's spawn wait for the user.
//
// They're in HOLDS, one key per user for the records and one per secret.
// The secret is never read back but to a claim (or the account's export),
// and is kept encrypted: AES-GCM, with a key of the user's own derived
// (HKDF) from the HOLDS_KEY secret and their sub, and the hold's name as
// the associated data, so a value can't be moved to another hold or user.
// One kept before that is plain text: read as it is, and encrypted the
// next time it's written or read.
//
//   GET    /api/holds                   every hold, with the brains and templates holding it; a name
//                                       one lists with no record is there too, recorded: false
//   POST   /api/holds                   { name, about?, where?, secret? }
//   GET    /api/holds/:name
//   PATCH  /api/holds/:name             { updated, name?, about?, where?, secret? }: a new name moves it
//                                       on every brain; secret null forgets it; 409 + it on a stale updated
//   DELETE /api/holds/:name             it, its secret, and it off every brain
//
// A template's holds are its host's Nix config's, so one a template holds
// is renamed or removed there first.

import { Invalid } from "./cards";
import type { Env } from "./index";
import type { User } from "./user";

export type Hold = {
  name: string;
  about: string;
  // Where its secret is kept, when it isn't here.
  where: string | null;
  // When its secret was set here, if it is.
  secret: string | null;
  created: string;
  updated: string;
};

export const LABEL = /^[\w.-]{1,64}$/;
const SECRET_MAX = 64 * 1024;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const json = (body: unknown, status = 200) => Response.json(body, { status });
const users = (env: Env, user: string) => env.USER.get(env.USER.idFromName(user)) as DurableObjectStub<User>;
const recordsKey = (user: string) => `${user}/holds`;
const secretKey = (user: string, name: string) => `${user}/secret/${name}`;

class Conflict extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hold?: Hold,
  ) {
    super(message);
  }
}

// Secrets at rest -------------------------------------------------------------------

// What an encrypted secret starts with: then base64 of the IV and the ciphertext.
const SEALED = "enc1:";
const utf8 = (s: string) => new TextEncoder().encode(s);

class NoKey extends Error {
  constructor() {
    super("the Worker has no HOLDS_KEY to keep secrets with (wrangler secret put HOLDS_KEY)");
  }
}

const userKeys = new Map<string, Promise<CryptoKey>>();
function keyFor(env: Env, user: string): Promise<CryptoKey> {
  if (!env.HOLDS_KEY) throw new NoKey();
  let k = userKeys.get(user);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", utf8(env.HOLDS_KEY), "HKDF", false, ["deriveKey"])
      .then((base) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8("corkboard holds"), info: utf8(user) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    userKeys.set(user, k);
  }
  return k;
}

async function seal(env: Env, user: string, name: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(name) }, await keyFor(env, user), utf8(plain)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  let s = "";
  for (const b of out) s += String.fromCharCode(b);
  return SEALED + btoa(s);
}

async function unseal(env: Env, user: string, name: string, stored: string): Promise<string> {
  if (!stored.startsWith(SEALED)) return stored;
  const bytes = Uint8Array.from(atob(stored.slice(SEALED.length)), (c) => c.charCodeAt(0));
  const key = await keyFor(env, user);
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: utf8(name) }, key, bytes.slice(12)));
  } catch {
    throw new Error(`the secret of ${name} doesn't open with this Worker's HOLDS_KEY`);
  }
}

// A secret as it was set, or null; one still in plain text is encrypted now.
async function readSecret(env: Env, user: string, name: string): Promise<string | null> {
  const stored = await env.HOLDS.get(secretKey(user, name));
  if (stored === null) return null;
  if (!stored.startsWith(SEALED) && env.HOLDS_KEY) await writeSecret(env, user, name, stored);
  return unseal(env, user, name, stored);
}

const writeSecret = async (env: Env, user: string, name: string, plain: string) => env.HOLDS.put(secretKey(user, name), await seal(env, user, name, plain));

async function records(env: Env, user: string): Promise<Record<string, Hold>> {
  return (await env.HOLDS.get<Record<string, Hold>>(recordsKey(user), "json")) ?? {};
}
const save = (env: Env, user: string, all: Record<string, Hold>) => env.HOLDS.put(recordsKey(user), JSON.stringify(all));

// The secrets of the holds named, those set here, by name: a claim's.
export async function secretsFor(env: Env, user: string, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of new Set(names)) {
    const v = await readSecret(env, user, n);
    if (v !== null) out[n] = v;
  }
  return out;
}

// The records and their secrets, for the account's export (api.ts): the
// one place a secret leaves but to a claim.
export type HoldsDump = { records: Record<string, Hold>; secrets: Record<string, string> };

export async function dumpHolds(env: Env, user: string): Promise<HoldsDump> {
  const all = await records(env, user);
  return { records: all, secrets: await secretsFor(env, user, Object.keys(all)) };
}

export async function restoreHolds(env: Env, user: string, d: HoldsDump): Promise<number> {
  if (typeof d?.records !== "object" || typeof d.secrets !== "object") throw new Invalid("holds must be { records, secrets }");
  for (const n of [...Object.keys(d.records), ...Object.keys(d.secrets)]) if (!LABEL.test(n)) throw new Invalid(`bad hold name ${n}`);
  for (const [n, v] of Object.entries(d.secrets)) await writeSecret(env, user, n, v);
  await save(env, user, d.records);
  return Object.keys(d.records).length;
}

// Who holds each name: the brains (archived ones too, by name) and each
// environment's templates, as "<environment>/<template>".
async function holders(env: Env, user: string) {
  const u = users(env, user);
  const by = new Map<string, { brains: string[]; templates: string[] }>();
  const at = (n: string) => by.get(n) ?? (by.set(n, { brains: [], templates: [] }), by.get(n)!);
  for (const b of await u.brains(true)) for (const c of b.credentials) at(c).brains.push(b.name);
  for (const e of await u.environments())
    for (const [name, t] of Object.entries(e.templates)) for (const c of t.credentials ?? []) at(c).templates.push(`${e.name}/${name}`);
  return by;
}

function fields(input: Record<string, unknown>): Partial<Hold> & { secretValue?: string | null } {
  const f: Partial<Hold> & { secretValue?: string | null } = {};
  if (input.about !== undefined) {
    if (typeof input.about !== "string" || input.about.length > 4000) throw new Invalid("about must be text of at most 4000 characters");
    f.about = input.about.trim();
  }
  if (input.where !== undefined) {
    if (input.where !== null && (typeof input.where !== "string" || input.where.length > 500)) throw new Invalid("where must be a line of at most 500 characters, or null");
    f.where = typeof input.where === "string" && input.where.trim() ? input.where.trim() : null;
  }
  if (input.secret !== undefined) {
    if (input.secret !== null && (typeof input.secret !== "string" || !input.secret || input.secret.length > SECRET_MAX))
      throw new Invalid(`secret must be text of at most ${SECRET_MAX} characters, or null to forget it`);
    f.secretValue = input.secret as string | null;
  }
  return f;
}

const later = (was: string) => {
  const at = now();
  return at > was ? at : new Date(Date.parse(was) + 1000).toISOString().replace(/\.\d+Z$/, "Z");
};

async function setSecret(env: Env, user: string, name: string, v: string | null | undefined, h: Hold, at: string) {
  if (v === undefined) return h;
  if (v === null) await env.HOLDS.delete(secretKey(user, name));
  else await writeSecret(env, user, name, v);
  return { ...h, secret: v === null ? null : at };
}

// Each brain holding `from` holds `to` instead, or nothing, if it's null.
async function moveOnBrains(env: Env, user: string, from: string, to: string | null) {
  const u = users(env, user);
  for (const b of await u.brains(true)) {
    if (!b.credentials.includes(from)) continue;
    const credentials = [...new Set(b.credentials.map((c) => (c === from ? to : c)).filter((c): c is string => c !== null))];
    const r = await u.updateBrain(b.name, b.updated, { credentials });
    if (!r.ok) {
      const { error, status } = r as unknown as { error: string; status: number };
      throw new Conflict(`couldn't change the ${b.name} brain: ${error}`, status);
    }
  }
}

export async function holdRoutes(request: Request, env: Env, user: string, body: () => Promise<Record<string, unknown>>): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const m = url.pathname.match(/^\/api\/holds(?:\/([^/]+))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const name = m[1] && decodeURIComponent(m[1]);
  try {
    const all = await records(env, user);
    const by = await holders(env, user);
    const shown = (h: Hold) => ({ ...h, recorded: true, ...(by.get(h.name) ?? { brains: [], templates: [] }) });
    if (!name) {
      if (method === "GET") {
        const unrecorded = [...by.keys()].filter((n) => !all[n]).map((n) => ({ name: n, about: "", where: null, secret: null, recorded: false, ...by.get(n)! }));
        return json([...Object.values(all).map(shown), ...unrecorded].sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      const input = await body();
      if (typeof input.name !== "string" || !LABEL.test(input.name)) throw new Invalid("name must be letters, digits, _ . and -, at most 64");
      if (all[input.name]) throw new Conflict(`there's already a hold ${input.name}`, 409);
      const { secretValue, ...f } = fields(input);
      const at = now();
      const h = await setSecret(env, user, input.name, secretValue, { name: input.name, about: "", where: null, secret: null, ...f, created: at, updated: at }, at);
      await save(env, user, { ...all, [h.name]: h });
      return json(shown(h), 201);
    }
    if (!LABEL.test(name)) return json({ error: `no hold ${name}` }, 404);
    const h = all[name];
    if (method === "GET") return h ? json(shown(h)) : json({ error: `no hold ${name}` }, 404);
    if (method === "PATCH") {
      if (!h) return json({ error: `no hold ${name}` }, 404);
      const input = await body();
      if (typeof input.updated !== "string") throw new Invalid("updated must be the hold's, as you last read it");
      if (input.updated !== h.updated) throw new Conflict(`${name} changed since; here it is now`, 409, h);
      const { secretValue, ...f } = fields(input);
      const at = later(h.updated);
      let next: Hold = { ...h, ...f, updated: at };
      const to = input.name ?? name;
      if (to !== name) {
        if (typeof to !== "string" || !LABEL.test(to)) throw new Invalid("name must be letters, digits, _ . and -, at most 64");
        if (all[to]) throw new Conflict(`there's already a hold ${to}`, 409);
        const nix = by.get(name)?.templates ?? [];
        if (nix.length) throw new Conflict(`${nix.join(", ")} hold${nix.length === 1 ? "s" : ""} ${name} in its host's Nix config; rename it there first`, 409);
        // Sealed again under its new name, which it's bound to.
        const kept = secretValue === undefined ? await readSecret(env, user, name) : null;
        if (kept !== null) await writeSecret(env, user, to, kept);
        await env.HOLDS.delete(secretKey(user, name));
        await moveOnBrains(env, user, name, to);
        next = { ...next, name: to };
      }
      next = await setSecret(env, user, to, secretValue, next, at);
      const rest = { ...all };
      delete rest[name];
      await save(env, user, { ...rest, [to]: next });
      return json({ ...next, recorded: true, ...((await holders(env, user)).get(to) ?? { brains: [], templates: [] }) });
    }
    if (method === "DELETE") {
      const held = by.get(name);
      if (!h && !held) return json({ error: `no hold ${name}` }, 404);
      if (held?.templates.length) throw new Conflict(`${held.templates.join(", ")} hold${held.templates.length === 1 ? "s" : ""} ${name} in its host's Nix config; take it out there first`, 409);
      await moveOnBrains(env, user, name, null);
      await env.HOLDS.delete(secretKey(user, name));
      if (h) {
        const rest = { ...all };
        delete rest[name];
        await save(env, user, rest);
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    if (e instanceof Invalid) return json({ error: e.message }, 400);
    if (e instanceof Conflict) return json({ error: e.message, ...(e.hold && { hold: e.hold }) }, e.status);
    if (e instanceof NoKey) return json({ error: e.message }, 503);
    throw e;
  }
}
