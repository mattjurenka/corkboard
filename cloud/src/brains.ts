// Brains as data (.agent/plans/brains.md): who agents work for, as rows in
// the user's object (user.ts) rather than a constant. A brain is its memory
// (memory.ts, one object per `<user>/<name>`), the Claude account its
// spawned agents run as (fleet.ts), what it holds, and the tools beyond
// memory its agents may use. Every user starts with one (STARTER). Its agents
// reach the whole public internet, as every slot does.
//
//   GET    /api/brains                  every brain, each with its memory's counts; ?archived=1 too
//   POST   /api/brains                  { name, title, description?, account?, credentials?,
//                                          abilities?, persona?, skin?, default? }
//   GET    /api/brains/:name
//   PATCH  /api/brains/:name            { updated, ...fields }: 409 + the brain on a stale updated
//   DELETE /api/brains/:name            archive it: out of lists, spawns and grants, its memory kept;
//                                        ?purge=<name>, of an archived one, empties its memory for good
//   POST   /api/brains/:name/restore
//   POST   /api/brains/:name/tokens     a token for its agents, in its memory
//
// The name never changes: it keys the memory. A token names its brain and
// the brain's random id, so one minted before a purge can't reach a new
// brain of the same name.

import type { Result } from "./board";
import { Invalid } from "./cards";
import type { Env, Props } from "./index";
import type { User } from "./user";

export type Brain = {
  // Random, made with it: what its tokens name, so none outlives a purge.
  id: string;
  name: string;
  title: string;
  description: string;
  account: string | null;
  credentials: string[];
  abilities: string[];
  // Who its sessions' avatar is (web/src/avatar/personas.ts), or the default one.
  persona: string | null;
  // Its avatar's skin, #rrggbb, or the model's own.
  skin: string | null;
  default: boolean;
  created: string;
  updated: string;
  archived?: string;
};

// What a brain's agents may do beyond memory: Pepper's chat with the user.
export const ABILITIES = ["chat"] as const;

// Its avatar's persona: web/src/avatar/personas.ts and nvim/lua/corkboard/personas.lua.
export const PERSONAS = ["tsundere", "bikini", "businesswoman", "nerd", "businessman", "shirtless"] as const;

// The brain a new account starts with: a plain assistant that can chat with
// the user, runs as no Claude account in particular and holds nothing. The
// accounts from before this have Pepper, made then with the first admin's
// own account and holds, and kept as it is.
export const STARTER = (at: string): Brain => ({
  id: crypto.randomUUID(),
  name: "assistant",
  title: "Assistant",
  description: "Your assistant.",
  account: null,
  credentials: [],
  abilities: ["chat"],
  persona: null,
  skin: null,
  default: true,
  created: at,
  updated: at,
});

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL = /^[\w.-]{1,64}$/;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const json = (body: unknown, status = 200) => Response.json(body, { status });
const users = (env: Env, user: string) => env.USER.get(env.USER.idFromName(user)) as DurableObjectStub<User>;
const memory = (env: Env, user: string, name: string) => env.MEMORY.get(env.MEMORY.idFromName(`${user}/${name}`));

function list(v: unknown, what: string, re: RegExp, max = 64): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Invalid(`${what} must be a list of at most ${max}`);
  const bad = v.find((x) => typeof x !== "string" || !re.test(x));
  if (bad !== undefined) throw new Invalid(`${what}: ${JSON.stringify(bad)} isn't one`);
  return [...new Set(v as string[])];
}

// The fields a create or a patch may set, checked; what isn't there is left out.
export function fieldsOf(input: Record<string, unknown>): Partial<Brain> {
  const f: Partial<Brain> = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 100) throw new Invalid("title must be a line of at most 100 characters");
    f.title = input.title.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 4000) throw new Invalid("description must be text of at most 4000 characters");
    f.description = input.description.trim();
  }
  if (input.account !== undefined) {
    if (input.account !== null && (typeof input.account !== "string" || !LABEL.test(input.account))) throw new Invalid("account must be a Claude account's name, or null");
    f.account = input.account as string | null;
  }
  if (input.credentials !== undefined) f.credentials = list(input.credentials, "credentials", LABEL);
  if (input.abilities !== undefined) f.abilities = list(input.abilities, "abilities", new RegExp(`^(${ABILITIES.join("|")})$`));
  if (input.persona !== undefined) {
    if (input.persona !== null && !(PERSONAS as readonly unknown[]).includes(input.persona)) throw new Invalid(`persona must be one of ${PERSONAS.join(", ")}, or null`);
    f.persona = input.persona as string | null;
  }
  if (input.skin !== undefined) {
    if (input.skin !== null && (typeof input.skin !== "string" || !/^#[0-9a-f]{6}$/.test(input.skin))) throw new Invalid("skin must be a colour, #rrggbb, or null");
    f.skin = input.skin as string | null;
  }
  if (input.default !== undefined) {
    if (typeof input.default !== "boolean") throw new Invalid("default must be true or false");
    f.default = input.default;
  }
  return f;
}

// A brain as the user's object keeps it, less the egress one made before
// every slot was open had, and with no persona or skin if made before them.
export function brainOf(doc: string): Brain {
  const { egress: _, ...b } = JSON.parse(doc) as Brain & { egress?: string[] };
  return { ...b, persona: b.persona ?? null, skin: b.skin ?? null };
}

export function create(input: Record<string, unknown>, at = now()): Brain {
  if (typeof input.name !== "string" || !NAME.test(input.name)) throw new Invalid("name must be lowercase letters, digits and -, starting with a letter, at most 32");
  const f = fieldsOf(input);
  if (!f.title) throw new Invalid("a brain needs a title");
  return { id: crypto.randomUUID(), name: input.name, description: "", account: null, credentials: [], abilities: [], persona: null, skin: null, default: false, ...f, title: f.title, created: at, updated: at };
}

// A brain token's brain, as a grant says it, if it's there and not archived.
// A grant from before a purge names a brain made earlier than this one.
export async function live(env: Env, user: string, name: string, id?: string): Promise<Brain | undefined> {
  const b = await users(env, user).brain(name);
  if (!b || b.archived || (id && id !== b.id)) return undefined;
  return b;
}

async function withCounts(env: Env, user: string, b: Brain) {
  return { ...b, memory: await memory(env, user, b.name).stats() };
}

const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status, body: (r as { brain?: Brain }).brain });
  return r.value;
};

export type Mint = (env: Env, props: Props, grant: { kind: "brain"; brain: string; agent: string; id: string }) => Promise<{ token: string; expires_at: string | null }>;

export async function brainRoutes(request: Request, env: Env, props: Props, body: () => Promise<Record<string, unknown>>, mint: Mint): Promise<Response> {
  const url = new URL(request.url);
  const u = users(env, props.userId);
  const method = request.method;
  const m = url.pathname.match(/^\/api\/brains(?:\/([^/]+)(?:\/(restore|tokens))?)?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, name, action] = m;
  try {
    if (!name) {
      if (method === "GET") {
        const all = await u.brains(url.searchParams.get("archived") === "1");
        return json(await Promise.all(all.map((b) => withCounts(env, props.userId, b))));
      }
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      return json(value(await u.addBrain(create(await body()))), 201);
    }
    if (!NAME.test(name)) return json({ error: `no brain ${name}` }, 404);
    if (action) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      if (action === "restore") return json(value(await u.restoreBrain(name)));
      const b = await live(env, props.userId, name);
      if (!b) return json({ error: `no brain ${name}` }, 404);
      return json(await mint(env, props, { kind: "brain", brain: b.name, agent: b.name, id: b.id }), 201);
    }
    if (method === "GET") {
      const b = await u.brain(name);
      return b ? json(await withCounts(env, props.userId, b)) : json({ error: `no brain ${name}` }, 404);
    }
    if (method === "PATCH") {
      const input = await body();
      if (input.name !== undefined && input.name !== name) throw new Invalid("a brain's name never changes; its title does");
      if (typeof input.updated !== "string") throw new Invalid("updated must be the brain's, as you last read it");
      return json(value(await u.updateBrain(name, input.updated, fieldsOf(input))));
    }
    if (method === "DELETE") {
      const purge = url.searchParams.get("purge");
      if (purge === null) return json(value(await u.archiveBrain(name)));
      if (purge !== name) throw new Invalid("purge=<its name>, typed again, to empty its memory for good");
      const b = await u.brain(name);
      if (!b) return json({ error: `no brain ${name}` }, 404);
      if (!b.archived) return json({ error: `archive ${name} first` }, 409);
      const busy = (await u.spawns(undefined, ["pending-approval", "queued", "running"], 200)).find((s) => s.brain === name);
      if (busy) return json({ error: `${name} has a spawn ${busy.state}: ${busy.id}` }, 409);
      await memory(env, props.userId, name).purge();
      await u.forgetBrain(name);
      return new Response(null, { status: 204 });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e: any) {
    if (e instanceof Invalid) return json({ error: e.message }, 400);
    if (e?.status) return json({ error: e.message, ...(e.body && { brain: e.body }) }, e.status);
    throw e;
  }
}
