// The fleet's queue (.agent/plans/agent-fleet.md, step 4): every spawn,
// whoever asked, is a row in the user's object (user.ts) tied to a card, and
// each environment's fleetd (fleet/fleetd) claims the ones for it.
//
//   PUT   /api/fleet/environments/:name      { templates, offer?, egress?, bindings?, jobs?, running? }: what
//                                            fleetd there can run, the most one VM there may have, what every
//                                            slot may reach, the brains whose memory it mounts, the Worker's
//                                            jobs its slots know, and what runs
//   GET   /api/fleet/environments            each environment and its templates
//   DELETE /api/fleet/environments/:name     one no fleetd runs as any more
//   GET   /api/spawns                        newest first: ?environment=, ?state=a,b, ?limit=
//   POST  /api/spawns                        { template?, brain?, task, environment?, board?, interactive?,
//                                            shell?, packages?, needs?, memory?, cores? }: the user's;
//                                            interactive, a session you talk to (task its first message, if
//                                            any); with no template, the smallest one with every need
//   GET   /api/spawns/:id
//   POST  /api/spawns/:id/approve            a brain's spawn of a template with credentials
//   POST  /api/spawns/:id/stop
//   POST  /api/spawns/:id/claim              { environment }: fleetd's; { spawn, token, repo, brainToken?, secrets? }
//   POST  /api/spawns/:id/report             { state, slot?, exit?, error?, result? }: fleetd's
//
// A spawn is a template (the VM) and, if it works for one, a brain
// (brains.ts), whose record stamps it: the Claude account it runs as, and
// whether a brain asking for it waits for the user (the brain or the
// template holds credentials; its card asks, with attention). Who asked is
// the requesting token's, never an argument: a brain may spawn for itself
// or for no brain, and a brainless spawn of a brain's runs as its account.
// The user's own spawns run.
//
// Its card says what it's for and how it went: the agent queued on it,
// a log line per state, the result at the end. The token fleetd is handed
// when it claims one is a card token for that card (the spawn token): the
// agent reports back through it. A brain's spawn also gets a token for the
// brain, which its memory hooks send, so it starts with the brain's context
// and its transcript becomes one of the brain's episodes.

import type { Result } from "./board";
import { type Card, type Fields, Invalid } from "../../lib/model/cards";
import type { Env, Props } from "./index";
import { NAME as BRAIN, live } from "./brains";
import { LABEL, secretsFor } from "./holds";
import type { Grant } from "./mcp";
import type { User } from "./user";

export const SPAWN_STATES = ["pending-approval", "queued", "running", "done", "failed", "stopped"] as const;
export type SpawnState = (typeof SPAWN_STATES)[number];
export const FINAL: readonly SpawnState[] = ["done", "failed", "stopped"];

// What a template is, as its environment's fleetd describes it (the host's
// manifest, from mkFleet): enough to place a spawn and apply the rule.
// credentials: the holds its capabilities have (holds.ts); absent from a
// manifest from before they were sent.
export type Template = { needsApproval: boolean; memory: number; cores: number; capNames: string[]; credentials?: string[] };
// What every slot there may reach: anything, or the hosts and the domains
// under the suffixes all of them allow.
export type Egress = { open: boolean; domains: string[]; suffixes: string[] };
// What's up there, as fleetd last saw it: the VMs that are always there,
// each slot and the spawn in it, and the memory budget they share (MiB).
// Each VM says how it's configured, when its host's manifest does: where it
// is, what it may reach, and what it runs as.
export type Config = {
  address: string | null;
  egress: "open" | "allowlist";
  allowedDomains: string[];
  allowedDomainSuffixes: string[];
  routedEgress: { reason: string; destinations: string[]; tcpPorts: string[]; udpPorts: string[] }[];
  cores: number | null;
  capabilities: string[];
  account: string | null;
  needsApproval?: boolean;
};
// The machine fleetd runs on: what it is and how busy (MiB, seconds).
export type Host = {
  name: string;
  os?: string;
  kernel?: string;
  cpu?: string;
  cores?: number;
  memory?: number;
  available?: number;
  load?: number[];
  uptime?: number;
};
export type Running = {
  budget: number | null;
  used: number;
  host?: Host;
  residents: { name: string; brain: string | null; memory: number | null; up: boolean; config?: Config }[];
  slots: { name: string; spawn: string | null; template: string | null; brain?: string | null; memory: number | null; config?: Config }[];
};
// The most one spawn there may ask for (MiB, vCPUs), as its host says; null
// for no more than its budget, or its cores.
export type Offer = { memory: number | null; cores: number | null };
// bindings: the brains whose memory its host mounts in their spawns' slots.
// jobs: the Worker's jobs (Spawn's job) its slots run; a fleetd that doesn't
// say runs none, since its guests would start an agent instead.
export type Environment = {
  name: string;
  templates: Record<string, Template>;
  seen: string;
  offer?: Offer;
  egress?: Egress;
  bindings?: string[];
  jobs?: string[];
  running?: Running;
};

// What the agent's tools are, brought by whoever spawns it: packages from the
// guest's own nixpkgs, or a flake's devShell ("." is its repo's). The guest
// builds it (fleet/guest/slot.nix); its host only hands the words in, so a
// shell can't reach anything of the host's.
export type Shell = { packages: string[] } | { flake: string };

export type Spawn = {
  id: string;
  template: string;
  environment: string;
  task: string;
  // Who it works for, and who asked: "user", or a brain.
  brain: string | null;
  by: string;
  // The Claude account it runs as, from a brain's record: its own, or the
  // spawning brain's for a brainless one; null for its host's default.
  account?: string | null;
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
  // A session you talk to (from the phone, or the fleet view) rather than a
  // task: it runs until it's stopped, and its fleetd serves its conversation
  // as a bridge does (fleet/fleetd/sessions.ts).
  interactive?: boolean;
  shell?: Shell;
  // Its VM's size, when asked for: at least the template's, at most the offer.
  memory?: number;
  cores?: number;
  // A job of the Worker's own rather than an agent's task: "consolidate" is
  // a brain's consolidator (memory.ts), a run with no tools that its slot
  // starts instead of an agent (fleet/guest/slot.nix). Never from input.
  job?: "consolidate";
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

export type SpawnInput = {
  template?: unknown;
  // Who it works for: a brain's name, or none.
  brain?: unknown;
  task?: unknown;
  environment?: unknown;
  board?: unknown;
  interactive?: unknown;
  // A flake ref, or { packages } / { flake }.
  shell?: unknown;
  packages?: unknown;
  // Capabilities the VM must have (a template's capNames), when no template is named.
  needs?: unknown;
  memory?: unknown;
  cores?: unknown;
};

const PACKAGE = /^[A-Za-z_][\w.+-]{0,127}$/;
const FLAKE = /^[\w.+:/#?=&@~,%-]{1,512}$/;

function shellOf(input: SpawnInput): Shell | undefined {
  let s = input.shell;
  if (s === undefined || s === null || s === "") s = input.packages === undefined ? undefined : { packages: input.packages };
  else if (typeof s === "string") s = { flake: s };
  if (s === undefined) return undefined;
  const o = s as Record<string, unknown>;
  if (Array.isArray(o.packages)) {
    if (!o.packages.length || o.packages.length > 64) throw new Refused(400, "packages must be 1 to 64 nixpkgs attribute names");
    const bad = o.packages.find((p) => typeof p !== "string" || !PACKAGE.test(p));
    if (bad !== undefined) throw new Refused(400, `${JSON.stringify(bad)} isn't a nixpkgs attribute name`);
    return { packages: o.packages as string[] };
  }
  if (typeof o.flake === "string" && FLAKE.test(o.flake)) return { flake: o.flake };
  throw new Refused(400, 'shell must be a flake ref (".#name" for the repo\'s own) or { packages: [...] }');
}

function size(v: unknown, what: string, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new Refused(400, `${what} must be a whole number from 1 to ${max}`);
  return v as number;
}

// A spawn, asked for by the user or a brain: placed, checked against the
// rule, and given its card. A job is asked for by the Worker (by "memory",
// for input.brain), which the rule has nothing to say about: it runs with no
// tools, so nothing to approve.
export async function spawn(env: Env, user: string, by: string, input: SpawnInput, job?: Spawn["job"]): Promise<Spawn> {
  const u = users(env, user);
  if (input.template !== undefined && input.template !== null && (typeof input.template !== "string" || !NAME.test(input.template)))
    throw new Refused(400, "template must be a template's name; spawn_status lists them");
  if (input.brain !== undefined && input.brain !== null && input.brain !== "" && (typeof input.brain !== "string" || !BRAIN.test(input.brain)))
    throw new Refused(400, "brain must be a brain's name; brain_list lists them");
  const interactive = input.interactive === true;
  // A session's task is only its first message, which it can go without.
  if (interactive && input.task === undefined) input.task = "";
  if (typeof input.task !== "string" || (!interactive && !input.task.trim())) throw new Refused(400, "task must say what the agent should do");
  if (input.task.length > 20_000) throw new Refused(400, "keep the task under 20000 characters");
  const task = input.task.trim();
  const shell = shellOf(input);
  const memory = size(input.memory, "memory (MiB)", 1 << 20);
  const cores = size(input.cores, "cores", 256);
  const needs = Array.isArray(input.needs) ? input.needs.map(String) : [];

  // The rule, first half: a brain spawns for itself or for no brain.
  const asks = typeof input.brain === "string" && input.brain ? input.brain : null;
  if (!job && by !== "user" && asks && asks !== by) throw new Refused(403, `${by} may spawn for itself or for no brain, not for ${asks}`);
  const b = asks ? await live(env, user, asks) : undefined;
  if (asks && !b) throw new Refused(400, `no brain ${asks}; brain_list lists them`);
  // A shell is the spawner's code, so never beside a brain's memory and credentials.
  if (shell && b) throw new Refused(400, `a shell of your own never goes beside the ${b.name} brain's memory; spawn it for no brain`);
  const account = b ? b.account : !job && by !== "user" ? ((await live(env, user, by))?.account ?? null) : null;

  const envs = await u.environments();
  const asked = typeof input.environment === "string" && input.environment ? input.environment : undefined;
  // Named, the template; else the smallest one with every need.
  const named = typeof input.template === "string" ? input.template : undefined;
  const fits = (e: Environment, t: Template) =>
    (!memory || !e.offer?.memory || Math.max(memory, t.memory) <= e.offer.memory) && (!cores || !e.offer?.cores || Math.max(cores, t.cores) <= e.offer.cores);
  const candidates = envs
    .filter((e) => (!asked || e.name === asked) && (!job || !!e.jobs?.includes(job)))
    .flatMap((e) =>
      Object.entries(e.templates)
        .filter(([name, t]) => (named ? name === named : needs.every((n) => t.capNames.includes(n))))
        .map(([name, t]) => ({ e, name, t })),
    )
    .sort((a, b) => a.t.capNames.length - b.t.capNames.length || a.t.memory - b.t.memory);
  if (!candidates.length) {
    if (named) {
      const known = [...new Set(envs.flatMap((e) => Object.keys(e.templates)))].sort();
      throw new Refused(400, `no ${asked ? `${asked} environment runs` : "environment runs"} ${named}; there are ${known.join(", ") || "none yet (no fleetd has said what it runs)"}`);
    }
    const offered = [...new Set(envs.flatMap((e) => Object.values(e.templates).flatMap((t) => t.capNames)))].sort();
    throw new Refused(400, `no ${asked ? `${asked} environment` : "environment"} has a VM with ${needs.join(", ") || "room for it"}; there are ${offered.join(", ") || "none"}`);
  }
  const placed = candidates.find((c) => fits(c.e, c.t));
  if (!placed) {
    const offers = [...new Set(candidates.map((c) => c.e))].map((e) => `${e.name} gives at most ${e.offer?.memory ?? "?"} MiB, ${e.offer?.cores ?? "?"} cores`);
    throw new Refused(400, `no VM that big: ${offers.join("; ")}`);
  }
  const { e: where, name: template, t } = placed;
  const environment = where.name;

  // The rule, second half: what holds credentials runs once the user says.
  const holds = [...new Set([...(b?.credentials ?? []), ...(t.credentials ?? [])])].sort();
  const held = t.needsApproval || holds.length > 0;
  const state: SpawnState = !job && by !== "user" && held ? "pending-approval" : "queued";

  const key = typeof input.board === "string" && input.board ? input.board : FLEET_BOARD;
  const boards = await u.boards();
  if (!boards.some((b) => b.key === key)) {
    if (key !== FLEET_BOARD) throw new Refused(400, `no board ${key}; list_boards has them`);
    await boardOf(env, user, key).describe("Fleet", null);
    await u.remember({ key, name: "Fleet", root: null });
  }

  const id = newId();
  const agent = `${template}-${id}`;
  const what = `${template}${b ? ` for the ${b.name} brain` : ""}`;
  const first = task.split("\n")[0].trim() || `${template} session`;
  const card = value(
    await boardOf(env, user, key).create({
      title: first.length > 100 ? first.slice(0, 99) + "…" : first,
      description: `${task}${task ? "\n\n---\n" : ""}${interactive ? "Session" : "Spawned agent"} ${id}: ${what} in ${environment}${shell ? `, with ${"flake" in shell ? shell.flake : shell.packages.join(" ")}` : ""}, asked by ${by}.`,
      status: "ready",
      agent,
      agent_state: "queued",
      labels: ["fleet"],
      attention: state === "pending-approval" ? `approve: ${by} wants to spawn ${what}, which holds ${holds.join(", ") || "credentials"}` : null,
    }),
  );
  return u.addSpawn({
    id,
    template,
    environment,
    task,
    brain: b?.name ?? null,
    by,
    account,
    state,
    board: key,
    card: card.id,
    agent,
    created: now(),
    ...(interactive && { interactive }),
    ...(shell && { shell }),
    ...(memory && { memory: Math.max(memory, t.memory) }),
    ...(cores && { cores: Math.max(cores, t.cores) }),
    ...(job && { job }),
  });
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
// board's project, if it has one: the claiming environment's clone of it).
// A brain's spawn also gets a token for the brain, unless the brain has gone
// since, which fails it, and every spawn the secrets of what it holds, its
// brain's and its template's, those set here (holds.ts).
async function claim(env: Env, user: string, props: Props, id: string, environment: unknown, mint: Mint) {
  if (typeof environment !== "string" || !NAME.test(environment)) throw new Invalid("environment must be the claiming environment's name");
  const u = users(env, user);
  const s = value(await u.claimSpawn(id, environment));
  const b = s.brain ? await live(env, user, s.brain) : undefined;
  if (s.brain && !b) {
    const error = `the ${s.brain} brain is archived or gone`;
    await report(env, user, id, { state: "failed", error });
    throw new Refused(409, error);
  }
  const { token } = await mint(env, props, { kind: "card", board: s.board, card: s.card, agent: s.agent });
  const brainToken = b && (await mint(env, props, { kind: "brain", brain: b.name, agent: s.agent, id: b.id })).token;
  const repo = await u.rootIn(s.board, environment);
  const t = (await u.environments()).find((e) => e.name === environment)?.templates[s.template];
  const secrets = s.job ? {} : await secretsFor(env, user, [...(b?.credentials ?? []), ...(t?.credentials ?? [])]);
  return { spawn: s, token, repo, ...(brainToken && { brainToken }), ...(Object.keys(secrets).length && { secrets }) };
}

// Routes -----------------------------------------------------------------------------

export type Mint = (
  env: Env,
  props: Props,
  grant: Extract<Grant, { kind: "card" }> | { kind: "brain"; brain: string; agent: string; id: string },
) => Promise<{ token: string; expires_at: string | null }>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

// One a fleetd from before brains on spawns still says is a brain's is none:
// it would hand out the brain's memory without the brain's rule.
function template(name: string, v: unknown): Template | undefined {
  const t = (v ?? {}) as Record<string, unknown>;
  const num = (k: string) => (Number.isFinite(t[k]) ? (t[k] as number) : 0);
  if (t.brain !== null && t.brain !== undefined) return undefined;
  if (typeof t.needsApproval !== "boolean") throw new Invalid(`templates.${name}.needsApproval must be true or false`);
  return {
    needsApproval: t.needsApproval,
    memory: num("memory"),
    cores: num("cores"),
    capNames: Array.isArray(t.capNames) ? t.capNames.map(String) : [],
    ...(Array.isArray(t.credentials) && { credentials: t.credentials.map(String).filter((c) => LABEL.test(c)).slice(0, 64) }),
  };
}

// A VM's config as fleetd says it, kept to strings and numbers of sane size;
// one that isn't an object is none.
function config(v: unknown): Config | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 256) : null);
  const strs = (x: unknown) => (Array.isArray(x) ? x.slice(0, 64).flatMap((i) => (typeof i === "string" ? [i.slice(0, 256)] : [])) : []);
  const routed = Array.isArray(c.routedEgress) ? c.routedEgress.slice(0, 16) : [];
  return {
    address: str(c.address),
    egress: c.egress === "open" ? "open" : "allowlist",
    allowedDomains: strs(c.allowedDomains),
    allowedDomainSuffixes: strs(c.allowedDomainSuffixes),
    routedEgress: routed.map((r) => {
      const e = (r ?? {}) as Record<string, unknown>;
      return { reason: str(e.reason)?.slice(0, 1000) ?? "", destinations: strs(e.destinations), tcpPorts: strs(e.tcpPorts), udpPorts: strs(e.udpPorts) };
    }),
    cores: Number.isFinite(c.cores) ? (c.cores as number) : null,
    capabilities: strs(c.capabilities),
    account: typeof c.account === "string" && NAME.test(c.account) ? c.account : null,
    ...(typeof c.needsApproval === "boolean" && { needsApproval: c.needsApproval }),
  };
}

function egress(v: unknown): Egress {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid("egress must be { open, domains, suffixes }");
  const e = v as Record<string, unknown>;
  const hosts = (x: unknown) => (Array.isArray(x) ? x.slice(0, 1024).flatMap((h) => (typeof h === "string" && /^[a-z0-9.-]{1,253}$/i.test(h) ? [h.toLowerCase()] : [])) : []);
  return { open: e.open === true, domains: hosts(e.domains), suffixes: hosts(e.suffixes).map((s) => s.replace(/^\./, "")) };
}

function host(v: unknown): Host | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h.name !== "string" || !NAME.test(h.name)) return undefined;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 128) : undefined);
  const num = (x: unknown) => (Number.isFinite(x) ? (x as number) : undefined);
  const load = Array.isArray(h.load) ? h.load.slice(0, 3).filter((n) => Number.isFinite(n)) : undefined;
  return { name: h.name, os: str(h.os), kernel: str(h.kernel), cpu: str(h.cpu), cores: num(h.cores), memory: num(h.memory), available: num(h.available), load, uptime: num(h.uptime) };
}

function running(v: unknown): Running {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid("running must be an object");
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => (Number.isFinite(x) ? (x as number) : null);
  const name = (x: unknown) => (typeof x === "string" && NAME.test(x) ? x : null);
  const id = (x: unknown) => (typeof x === "string" && ID.test(x) ? x : null);
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 64) : []).map((i) => (i ?? {}) as Record<string, unknown>);
  const h = host(r.host);
  return {
    budget: num(r.budget),
    used: num(r.used) ?? 0,
    ...(h && { host: h }),
    residents: list(r.residents).flatMap((i) => {
      const c = config(i.config);
      return name(i.name) ? [{ name: name(i.name)!, brain: name(i.brain), memory: num(i.memory), up: i.up === true, ...(c && { config: c }) }] : [];
    }),
    slots: list(r.slots).flatMap((i) => {
      const c = config(i.config);
      return name(i.name) ? [{ name: name(i.name)!, spawn: id(i.spawn), template: name(i.template), ...(i.brain !== undefined && { brain: name(i.brain) }), memory: num(i.memory), ...(c && { config: c }) }] : [];
    }),
  };
}

// machine: a machine token's environment, the only one it may speak for,
// spawn into, or claim, stop and report spawns of. It approves nothing.
export async function fleetRoutes(request: Request, env: Env, props: Props, body: () => Promise<Record<string, unknown>>, mint: Mint, machine?: string): Promise<Response> {
  const url = new URL(request.url);
  const user = props.userId;
  const u = users(env, user);
  const method = request.method;
  const mine = (environment: unknown) => {
    if (machine && environment !== machine) throw new Refused(403, `a machine token is ${machine}'s, not ${environment}'s`);
  };
  try {
    const e = url.pathname.match(/^\/api\/fleet\/environments(?:\/([^/]+))?$/);
    if (e) {
      if (!e[1]) return method === "GET" ? json(await u.environments()) : json({ error: "method not allowed" }, 405);
      if (!NAME.test(e[1])) throw new Invalid(`bad environment name ${e[1]}`);
      mine(e[1]);
      if (method === "DELETE") return (await u.forgetEnvironment(e[1])) ? new Response(null, { status: 204 }) : json({ error: `no environment ${e[1]}` }, 404);
      if (method !== "PUT") return json({ error: "method not allowed" }, 405);
      const input = await body();
      if (typeof input.templates !== "object" || input.templates === null || Array.isArray(input.templates)) throw new Invalid("templates must be an object of templates by name");
      const templates = Object.fromEntries(
        Object.entries(input.templates).flatMap(([name, t]) => {
          if (!NAME.test(name)) throw new Invalid(`bad template name ${name}`);
          const parsed = template(name, t);
          return parsed ? [[name, parsed]] : [];
        }),
      );
      const environment: Environment = { name: e[1], templates, seen: now() };
      if (typeof input.offer === "object" && input.offer !== null) {
        const o = input.offer as Record<string, unknown>;
        const n = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : null);
        environment.offer = { memory: n(o.memory), cores: n(o.cores) };
      }
      if (input.egress !== undefined) environment.egress = egress(input.egress);
      if (input.bindings !== undefined) {
        if (!Array.isArray(input.bindings) || input.bindings.some((b) => typeof b !== "string" || !BRAIN.test(b))) throw new Invalid("bindings must be a list of brains' names");
        environment.bindings = [...new Set(input.bindings as string[])].slice(0, 64);
      }
      if (input.jobs !== undefined) {
        if (!Array.isArray(input.jobs) || input.jobs.some((j) => typeof j !== "string" || !NAME.test(j))) throw new Invalid("jobs must be a list of jobs' names");
        environment.jobs = [...new Set(input.jobs as string[])].slice(0, 16);
      }
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
      const input = await body();
      if (machine) {
        if (input.environment !== undefined) mine(input.environment);
        input.environment = machine;
      }
      return json(await spawn(env, user, "user", input), 201);
    }
    if (!ID.test(id)) return json({ error: `no spawn ${id}` }, 404);
    if (!action) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const s = await u.spawn(id);
      return s ? json(s) : json({ error: `no spawn ${id}` }, 404);
    }
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    if (machine) {
      if (action === "approve") throw new Refused(403, "only the owner approves a spawn");
      const s = await u.spawn(id);
      if (s) mine(s.environment);
    }
    if (action === "approve") return json(await approve(env, user, id));
    if (action === "stop") return json(await stop(env, user, id));
    const input = await body();
    if (action === "claim") {
      mine(input.environment);
      return json(await claim(env, user, props, id, input.environment, mint));
    }
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
    offer: e.offer,
    egress: e.egress,
    bindings: e.bindings,
    templates: Object.entries(e.templates).map(([name, t]) => ({ name, holdsCredentials: t.needsApproval, memory: t.memory, capabilities: t.capNames })),
  }));
  // Who a spawn may work for (its brain).
  const brains = (await u.brains()).map((b) => ({ name: b.name, title: b.title, account: b.account, holdsCredentials: b.credentials.length > 0 }));
  return { environments, brains, spawns: (await u.spawns(undefined, [], 20)).map(({ task, ...s }) => ({ ...s, task: task.slice(0, 200) })) };
}
