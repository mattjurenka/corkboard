// The fleet's queue (.agent/plans/agent-fleet.md, step 4): every spawn,
// whoever asked, is a row in the user's object (user.ts) tied to a card, and
// each environment's fleetd (fleet/fleetd) claims the ones for it.
//
//   PUT   /api/fleet/environments/:name      { templates, running? }: what fleetd there can run, and runs
//   GET   /api/fleet/environments            each environment and its templates
//   GET   /api/spawns                        newest first: ?environment=, ?state=a,b, ?limit=
//   POST  /api/spawns                        { template, task, environment?, board? }: the user's
//   GET   /api/spawns/:id
//   POST  /api/spawns/:id/approve            a brain's spawn of a template with credentials
//   POST  /api/spawns/:id/stop
//   POST  /api/spawns/:id/claim              { environment }: fleetd's; { spawn, token, repo }
//   POST  /api/spawns/:id/report             { state, slot?, exit?, error?, result? }: fleetd's
//
// A spawn's brain is the template's, and who asked is the requesting
// token's, never an argument: a brain may only spawn its own templates or
// brainless ones, and one that holds credentials waits for the user to
// approve it (its card asks, with attention). The user's own spawns run.
//
// Its card says what it's for and how it went: the agent queued on it,
// a log line per state, the result at the end. The token fleetd is handed
// when it claims one is a card token for that card (the spawn token): the
// agent reports back through it, and it's the only corkboard grant it gets.

import type { Result } from "./board";
import { type Card, type Fields, Invalid } from "./cards";
import type { Env, Props } from "./index";
import type { Grant } from "./mcp";
import type { User } from "./user";

export const SPAWN_STATES = ["pending-approval", "queued", "running", "done", "failed", "stopped"] as const;
export type SpawnState = (typeof SPAWN_STATES)[number];
export const FINAL: readonly SpawnState[] = ["done", "failed", "stopped"];

// What a template is, as its environment's fleetd describes it (the host's
// manifest, from mkFleet): enough to place a spawn and apply the rule.
export type Template = { brain: string | null; needsApproval: boolean; memory: number; cores: number; capNames: string[] };
// What's up there, as fleetd last saw it: the VMs that are always there,
// each slot and the spawn in it, and the memory budget they share (MiB).
export type Running = {
  budget: number | null;
  used: number;
  residents: { name: string; brain: string | null; memory: number | null; up: boolean }[];
  slots: { name: string; spawn: string | null; template: string | null; memory: number | null }[];
};
export type Environment = { name: string; templates: Record<string, Template>; seen: string; running?: Running };

export type Spawn = {
  id: string;
  template: string;
  environment: string;
  task: string;
  // The template's brain, and who asked: "user", or a brain.
  brain: string | null;
  by: string;
  state: SpawnState;
  board: string;
  card: string;
  // The agent's name on its card.
  agent: string;
  created: string;
  approved?: string;
  claimed?: string;
  started?: string;
  ended?: string;
  slot?: string;
  exit?: number;
  error?: string;
  // Its answer, cut to RESULT characters.
  result?: string;
  stopRequested?: boolean;
};

export type SpawnReport = Pick<Spawn, "state" | "slot" | "exit" | "error" | "result">;

const RESULT = 8000;
// A brain's spawns, and the user's from the phone, go here unless they name a board.
export const FLEET_BOARD = "fleet";

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ID = /^[a-z0-9]{6,20}$/;
const NAME = /^[\w-]{1,64}$/;

type Users = DurableObjectStub<User>;
type Board = {
  create(f: Fields): Promise<Result<Card>>;
  get(id: string): Promise<Result<Card>>;
  update(id: string, f: Fields, version: number): Promise<Result<Card>>;
  appendLog(id: string, who: string, note: string): Promise<Result<unknown>>;
  describe(name: string, root: string | null): Promise<void>;
};

const users = (env: Env, user: string) => env.USER.get(env.USER.idFromName(user));
const boardOf = (env: Env, user: string, key: string) => env.BOARD.get(env.BOARD.idFromName(`${user}/${key}`)) as unknown as Board;

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Refused(r.status, r.error);
  return r.value;
}

// A spawn refused, with the status a route answers it with.
export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Spawning ---------------------------------------------------------------------------

export type SpawnInput = { template?: unknown; task?: unknown; environment?: unknown; board?: unknown };

// A spawn, asked for by the user or a brain: placed, checked against the
// rule, and given its card.
export async function spawn(env: Env, user: string, by: string, input: SpawnInput): Promise<Spawn> {
  const u = users(env, user);
  if (typeof input.template !== "string" || !input.template) throw new Refused(400, "template must be a template's name; spawn_status lists them");
  if (typeof input.task !== "string" || !input.task.trim()) throw new Refused(400, "task must say what the agent should do");
  if (input.task.length > 20_000) throw new Refused(400, "keep the task under 20000 characters");
  const template = input.template;
  const task = input.task.trim();

  const envs = await u.environments();
  const asked = typeof input.environment === "string" && input.environment ? input.environment : undefined;
  const where = envs.filter((e) => (!asked || e.name === asked) && e.templates[template]);
  if (!where.length) {
    const known = [...new Set(envs.flatMap((e) => Object.keys(e.templates)))].sort();
    throw new Refused(400, `no ${asked ? `${asked} environment runs` : "environment runs"} ${template}; there are ${known.join(", ") || "none yet (no fleetd has said what it runs)"}`);
  }
  const environment = where[0].name;
  const t = where[0].templates[template];

  // The rule: a brain's own templates or brainless ones, and those with
  // credentials only once the user says.
  if (by !== "user" && t.brain && t.brain !== by) throw new Refused(403, `${template} is the ${t.brain} brain's; ${by} can't spawn it`);
  const state: SpawnState = by !== "user" && t.needsApproval ? "pending-approval" : "queued";

  const key = typeof input.board === "string" && input.board ? input.board : FLEET_BOARD;
  const boards = await u.boards();
  if (!boards.some((b) => b.key === key)) {
    if (key !== FLEET_BOARD) throw new Refused(400, `no board ${key}; list_boards has them`);
    await boardOf(env, user, key).describe("Fleet", null);
    await u.remember({ key, name: "Fleet", root: null });
  }

  const id = newId();
  const agent = `${template}-${id}`;
  const first = task.split("\n")[0].trim();
  const card = value(
    await boardOf(env, user, key).create({
      title: first.length > 100 ? first.slice(0, 99) + "…" : first,
      description: `${task}\n\n---\nSpawned agent ${id}: ${template} in ${environment}, asked by ${by}.`,
      status: "ready",
      agent,
      agent_state: "queued",
      labels: ["fleet"],
      attention: state === "pending-approval" ? `approve: ${by} wants to spawn ${template}, which holds credentials` : null,
    }),
  );
  return u.addSpawn({ id, template, environment, task, brain: t.brain, by, state, board: key, card: card.id, agent, created: now() });
}

// A line on the spawn's card, and the card moved along with it. The agent
// may have moved it itself; this never moves it back.
async function onCard(env: Env, user: string, s: Spawn, note: string, fn?: (c: Card) => Fields) {
  const board = boardOf(env, user, s.board);
  await board.appendLog(s.card, "fleet", note);
  if (!fn) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await board.get(s.card);
    if (!c.ok) return;
    const fields = fn(c.value);
    if (!Object.keys(fields).length) return;
    const r = await board.update(s.card, fields, c.value.version);
    if (r.ok || r.status !== 409) return;
  }
}

async function approve(env: Env, user: string, id: string) {
  const s = value(await users(env, user).approveSpawn(id));
  await onCard(env, user, s, "approved", () => ({ attention: null }));
  return s;
}

export async function stop(env: Env, user: string, id: string) {
  const s = value(await users(env, user).stopSpawn(id));
  await onCard(env, user, s, s.state === "stopped" ? "stopped before it ran" : "asked to stop", (c) => (s.state === "stopped" && c.status !== "done" ? { agent_state: null, attention: null, status: "backlog" } : {}));
  return s;
}

async function report(env: Env, user: string, id: string, input: Record<string, unknown>) {
  if (!SPAWN_STATES.includes(input.state as SpawnState)) throw new Invalid(`state must be one of ${SPAWN_STATES.join(", ")}`);
  const r: SpawnReport = { state: input.state as SpawnState };
  if (input.slot !== undefined) r.slot = String(input.slot).slice(0, 64);
  if (input.exit !== undefined && input.exit !== null) {
    if (!Number.isInteger(input.exit)) throw new Invalid("exit must be the agent's exit status");
    r.exit = input.exit as number;
  }
  if (typeof input.error === "string" && input.error) r.error = input.error.slice(0, 2000);
  if (typeof input.result === "string" && input.result) r.result = input.result.length > RESULT ? input.result.slice(0, RESULT - 1) + "…" : input.result;
  const before = await users(env, user).spawn(id);
  const s = value(await users(env, user).reportSpawn(id, r));
  if (before?.state === s.state) return s;
  if (s.state === "running") await onCard(env, user, s, `running${s.slot ? ` in ${s.slot}` : ""} (${s.environment})`);
  else if (s.state === "done")
    await onCard(env, user, s, `done${s.result ? `:\n${s.result}` : ""}`, (c) =>
      c.status === "done" || c.status === "review" ? {} : { status: "review", agent_state: "needs-review" },
    );
  else if (s.state === "failed")
    await onCard(env, user, s, `failed: ${s.error ?? `exit ${s.exit ?? "?"}`}${s.result ? `\n${s.result}` : ""}`, (c) =>
      c.status === "done" ? {} : { attention: `spawn failed: ${(s.error ?? `exit ${s.exit ?? "?"}`).split("\n")[0].slice(0, 160)}` },
    );
  else if (s.state === "stopped") await onCard(env, user, s, "stopped", (c) => (c.status === "done" ? {} : { agent_state: null }));
  return s;
}

// fleetd's claim: the spawn, its card token, and the repo to work in (its
// board's project, if it has one).
async function claim(env: Env, user: string, props: Props, id: string, environment: unknown, mint: Mint) {
  if (typeof environment !== "string" || !NAME.test(environment)) throw new Invalid("environment must be the claiming environment's name");
  const u = users(env, user);
  const s = value(await u.claimSpawn(id, environment));
  const { token } = await mint(env, props, { kind: "card", board: s.board, card: s.card, agent: s.agent });
  const repo = (await u.boards()).find((b) => b.key === s.board)?.root ?? null;
  return { spawn: s, token, repo };
}

// Routes -----------------------------------------------------------------------------

export type Mint = (env: Env, props: Props, grant: Extract<Grant, { kind: "card" }>) => Promise<{ token: string; expires_at: string }>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

function template(name: string, v: unknown): Template {
  const t = (v ?? {}) as Record<string, unknown>;
  const num = (k: string) => (Number.isFinite(t[k]) ? (t[k] as number) : 0);
  if (t.brain !== null && t.brain !== undefined && (typeof t.brain !== "string" || !NAME.test(t.brain))) throw new Invalid(`templates.${name}.brain must be a brain's name or null`);
  if (typeof t.needsApproval !== "boolean") throw new Invalid(`templates.${name}.needsApproval must be true or false`);
  return {
    brain: (t.brain as string | undefined) ?? null,
    needsApproval: t.needsApproval,
    memory: num("memory"),
    cores: num("cores"),
    capNames: Array.isArray(t.capNames) ? t.capNames.map(String) : [],
  };
}

function running(v: unknown): Running {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid("running must be an object");
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => (Number.isFinite(x) ? (x as number) : null);
  const name = (x: unknown) => (typeof x === "string" && NAME.test(x) ? x : null);
  const id = (x: unknown) => (typeof x === "string" && ID.test(x) ? x : null);
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 64) : []).map((i) => (i ?? {}) as Record<string, unknown>);
  return {
    budget: num(r.budget),
    used: num(r.used) ?? 0,
    residents: list(r.residents).flatMap((i) => (name(i.name) ? [{ name: name(i.name)!, brain: name(i.brain), memory: num(i.memory), up: i.up === true }] : [])),
    slots: list(r.slots).flatMap((i) => (name(i.name) ? [{ name: name(i.name)!, spawn: id(i.spawn), template: name(i.template), memory: num(i.memory) }] : [])),
  };
}

export async function fleetRoutes(request: Request, env: Env, props: Props, body: () => Promise<Record<string, unknown>>, mint: Mint): Promise<Response> {
  const url = new URL(request.url);
  const user = props.userId;
  const u = users(env, user);
  const method = request.method;
  try {
    const e = url.pathname.match(/^\/api\/fleet\/environments(?:\/([^/]+))?$/);
    if (e) {
      if (!e[1]) return method === "GET" ? json(await u.environments()) : json({ error: "method not allowed" }, 405);
      if (method !== "PUT") return json({ error: "method not allowed" }, 405);
      if (!NAME.test(e[1])) throw new Invalid(`bad environment name ${e[1]}`);
      const input = await body();
      if (typeof input.templates !== "object" || input.templates === null || Array.isArray(input.templates)) throw new Invalid("templates must be an object of templates by name");
      const templates = Object.fromEntries(
        Object.entries(input.templates).map(([name, t]) => {
          if (!NAME.test(name)) throw new Invalid(`bad template name ${name}`);
          return [name, template(name, t)];
        }),
      );
      const environment: Environment = { name: e[1], templates, seen: now() };
      if (input.running !== undefined) environment.running = running(input.running);
      return json(await u.putEnvironment(environment));
    }

    const m = url.pathname.match(/^\/api\/spawns(?:\/([^/]+)(?:\/(approve|stop|claim|report))?)?$/);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, action] = m;
    if (!id) {
      if (method === "GET") {
        const states = (url.searchParams.get("state") ?? "").split(",").filter(Boolean) as SpawnState[];
        const bad = states.find((s) => !SPAWN_STATES.includes(s));
        if (bad) throw new Invalid(`no state ${bad}`);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        return json(await u.spawns(url.searchParams.get("environment") ?? undefined, states, limit));
      }
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      return json(await spawn(env, user, "user", await body()), 201);
    }
    if (!ID.test(id)) return json({ error: `no spawn ${id}` }, 404);
    if (!action) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const s = await u.spawn(id);
      return s ? json(s) : json({ error: `no spawn ${id}` }, 404);
    }
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    if (action === "approve") return json(await approve(env, user, id));
    if (action === "stop") return json(await stop(env, user, id));
    const input = await body();
    if (action === "claim") return json(await claim(env, user, props, id, input.environment, mint));
    return json(await report(env, user, id, input));
  } catch (err) {
    if (err instanceof Refused) return json({ error: err.message }, err.status);
    throw err;
  }
}

// For the MCP tools: the newest spawns, and what can be spawned where.
export async function status(env: Env, user: string, id?: string) {
  const u = users(env, user);
  if (id) {
    const s = await u.spawn(id);
    if (!s) throw new Refused(404, `no spawn ${id}`);
    return s;
  }
  const environments = (await u.environments()).map((e) => ({
    name: e.name,
    seen: e.seen,
    running: e.running,
    templates: Object.entries(e.templates).map(([name, t]) => ({ name, brain: t.brain, holdsCredentials: t.needsApproval, memory: t.memory, capabilities: t.capNames })),
  }));
  return { environments, spawns: (await u.spawns(undefined, [], 20)).map(({ task, ...s }) => ({ ...s, task: task.slice(0, 200) })) };
}
