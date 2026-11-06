// The account's fleet object (.agent/plans/ciphertext-relay.md, step 4): what
// the fleet keeps sealed from the Worker, which keeps only the queue.
//
//   spawn:<id>  task, shell, result, error, at: a spawn's words. The Worker has
//               its id, state and sizes, and sealed: true; fleetd reads the task
//               at its claim and writes the result here (fleet/fleetd/queue.ts).
//   hold:<name> about, where, secret, secret_at, created, updated: a hold, as
//               the Worker's holds.ts had it, its secret with it. It reaches a
//               slot only through a claim's GET .../spawns/:id?holds=.
//   env:<name>  manifest: an environment's whole manifest, as its fleetd sends
//               it (hosts, slots, VM addresses, egress, what's running).
//
// Every paired device has a replica, so the phone reads these as they are.
//
// The node's /api/node/fleet (server.ts):
//   POST   /spawns                 a spawn, as the Worker's POST /api/spawns: sealed here, queued there
//   GET    /spawns/:id[?holds=a,b] its sealed part; with holds, their secrets, on a channel or loopback
//   PUT    /spawns/:id             { result?, error? }: fleetd's, at the end
//   GET    /environments           the manifests
//   PUT    /environments/:name     { manifest }: fleetd's
//   /holds[/:name]                 as the Worker's /api/holds (holds.ts)

import { Invalid } from "../../lib/model/cards";
import type { MergedCard } from "../../lib/e2ee/merge";
import { FLEET, environmentRecord, holdRecord, spawnRecord } from "./objects";
import type { Replicas } from "./replicas";

export type Shell = { packages: string[] } | { flake: string };
export type SealedSpawn = { id: string; task: string; shell: Shell | null; result: string | null; error: string | null; at: string };
export type Hold = { name: string; about: string; where: string | null; secret: string | null; created: string; updated: string };
// Who holds a name: the brains (from the Worker's brain records, until they
// move) and each environment's templates, as "<environment>/<template>".
export type Holders = { brains: string[]; templates: string[] };
// What the node asks the Worker, as the node's /mcp spawn tools do (serve.ts's fleetQueue).
export type Worker = (method: string, path: string, body?: unknown) => Promise<any>;

export class Conflict extends Error {
  constructor(
    message: string,
    readonly hold?: Hold,
  ) {
    super(message);
  }
}

export const LABEL = /^[\w.-]{1,64}$/;
export const SPAWN_ID = /^[a-z0-9]{6,20}$/;
const SECRET_MAX = 64 * 1024;
const RESULT = 8000;
const TASK = 20_000;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// As the Worker makes them (its fleet.ts's newId), so the node can name the
// spawn before the Worker queues it.
export const newSpawnId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const later = (was: string) => {
  const at = now();
  return at > was ? at : new Date(Date.parse(was) + 1000).toISOString().replace(/\.\d+Z$/, "Z");
};
const str = (v: unknown) => (typeof v === "string" ? v : null);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const PREFIX = { spawn: spawnRecord(""), hold: holdRecord(""), env: environmentRecord("") };

export class FleetRecords {
  constructor(
    private replicas: Replicas,
    private worker?: () => Worker | undefined,
  ) {}

  has() {
    return !!this.replicas.get("fleet", FLEET);
  }

  // Whether the fleet's sealed here yet: a fleetd keeps its environment
  // here, or the holds have moved in. Until then the Worker's are the fleet's.
  inUse() {
    return this.has() && (this.records(PREFIX.env).length > 0 || this.records(PREFIX.hold).length > 0);
  }

  private records(prefix: string): MergedCard[] {
    const r = this.replicas.get("fleet", FLEET);
    if (!r) throw new Invalid("this node has no fleet object");
    return r.cards().filter((c) => c.id.startsWith(prefix) && !c.deleted);
  }
  private record(id: string) {
    return this.records(id).find((c) => c.id === id);
  }
  private set(card: string, set: Record<string, unknown>) {
    return this.replicas.change("fleet", FLEET, { t: "card", card, set });
  }

  // Spawns -------------------------------------------------------------------------

  spawn(id: string): SealedSpawn | undefined {
    const m = this.record(spawnRecord(id));
    if (!m || typeof m.task !== "string") return;
    return { id, task: m.task, shell: (m.shell as Shell | null) ?? null, result: str(m.result), error: str(m.error), at: String(m.at ?? "") };
  }

  async seal(id: string, task: string, shell: Shell | null) {
    if (!SPAWN_ID.test(id)) throw new Invalid("bad spawn id");
    if (task.length > TASK) throw new Invalid(`keep the task under ${TASK} characters`);
    await this.set(spawnRecord(id), { task, shell, result: null, error: null, at: now() });
  }

  async report(id: string, input: Record<string, unknown>) {
    if (!this.spawn(id)) throw new Invalid(`no spawn ${id} here`);
    const set: Record<string, unknown> = {};
    if (typeof input.result === "string") set.result = input.result ? cut(input.result, RESULT) : null;
    if (typeof input.error === "string") set.error = input.error ? cut(input.error, 2000) : null;
    if (Object.keys(set).length) await this.set(spawnRecord(id), set);
    return this.spawn(id)!;
  }

  // The Worker's spawn (or status) with its words put back, where they're here.
  open<T extends { id?: unknown }>(s: T): T {
    const here = typeof s?.id === "string" ? this.has() && this.spawn(s.id) : undefined;
    if (!here) return s;
    return { ...s, task: here.task, ...(here.shell && { shell: here.shell }), ...(here.result !== null && { result: here.result }), ...(here.error !== null && { error: here.error }) };
  }

  // A spawn, as the Worker's POST /api/spawns takes it: its words kept here
  // and the rest queued there, under an id named here first. One the Worker
  // refuses is dropped again.
  async queue(input: Record<string, unknown>) {
    const w = this.worker?.();
    if (!w) throw new Invalid("this machine isn't signed in to the fleet");
    const { task, shell: s, packages, ...rest } = input;
    const interactive = rest.interactive === true;
    if (typeof task !== "string" && !(interactive && task === undefined)) throw new Invalid("task must say what the agent should do");
    const words = typeof task === "string" ? task.trim() : "";
    if (!interactive && !words) throw new Invalid("task must say what the agent should do");
    const shell = shellOf(s, packages);
    // The Worker's rule: a shell of the spawner's never goes beside a brain's memory.
    if (shell && typeof rest.brain === "string" && rest.brain) throw new Invalid(`a shell of your own never goes beside the ${rest.brain} brain's memory; spawn it for no brain`);
    const id = newSpawnId();
    await this.seal(id, words, shell);
    try {
      return this.open(await w("POST", "/spawns", { ...rest, id, sealed: true }));
    } catch (e) {
      await this.replicas.change("fleet", FLEET, { t: "card", card: spawnRecord(id), set: { deleted: now() } });
      throw e;
    }
  }

  // Environments ---------------------------------------------------------------------

  environments(): Record<string, unknown>[] {
    return this.records(PREFIX.env).flatMap((m) => (m.manifest && typeof m.manifest === "object" ? [{ ...(m.manifest as object), name: m.id.slice(PREFIX.env.length) }] : []));
  }

  async putEnvironment(name: string, manifest: unknown) {
    if (!LABEL.test(name)) throw new Invalid("bad environment name");
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Invalid("manifest must be an object");
    if (JSON.stringify(manifest).length > 256 * 1024) throw new Invalid("that manifest is too big");
    await this.set(environmentRecord(name), { manifest, seen: now() });
  }

  // Holds ----------------------------------------------------------------------------

  private hold(name: string): (Hold & { value: string | null }) | undefined {
    const m = this.record(holdRecord(name));
    if (!m || typeof m.created !== "string") return;
    return { name, about: String(m.about ?? ""), where: str(m.where), secret: str(m.secret_at), created: m.created, updated: String(m.updated ?? m.created), value: str(m.secret) };
  }
  private holds(): Hold[] {
    return this.records(PREFIX.hold).flatMap((m) => {
      const h = this.hold(m.id.slice(PREFIX.hold.length));
      return h ? [shown(h)] : [];
    });
  }

  // The secrets of the holds named, those set here: a claim's.
  secrets(names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of new Set(names)) {
      const v = LABEL.test(n) ? this.hold(n)?.value : null;
      if (v) out[n] = v;
    }
    return out;
  }

  private async brains(): Promise<{ name: string; credentials: string[]; updated: string }[]> {
    const w = this.worker?.();
    if (!w) return [];
    return ((await w("GET", "/brains?archived=1").catch(() => [])) as any[]).filter((b) => b && typeof b.name === "string" && Array.isArray(b.credentials));
  }

  private async holders(): Promise<Map<string, Holders>> {
    const by = new Map<string, Holders>();
    const at = (n: string) => by.get(n) ?? (by.set(n, { brains: [], templates: [] }), by.get(n)!);
    for (const b of await this.brains()) for (const c of b.credentials) at(c).brains.push(b.name);
    for (const e of this.environments()) {
      const ts = (e.templates ?? {}) as Record<string, { credentials?: string[] }>;
      for (const [t, v] of Object.entries(ts)) for (const c of v?.credentials ?? []) at(c).templates.push(`${e.name}/${t}`);
    }
    return by;
  }

  // Each brain holding from holds to instead, or nothing, if it's null.
  private async moveOnBrains(from: string, to: string | null) {
    const w = this.worker?.();
    for (const b of await this.brains()) {
      if (!b.credentials.includes(from)) continue;
      const credentials = [...new Set(b.credentials.map((c) => (c === from ? to : c)).filter((c): c is string => c !== null))];
      await w!("PATCH", `/brains/${encodeURIComponent(b.name)}`, { updated: b.updated, credentials });
    }
  }

  // The Worker's /api/holds routes, on this object. name: the path's.
  async holdRoute(method: string, name: string | undefined, body: () => Promise<Record<string, unknown>>): Promise<{ status: number; body: unknown }> {
    const by = await this.holders();
    const held = (h: Hold) => ({ ...h, recorded: true, ...(by.get(h.name) ?? { brains: [], templates: [] }) });
    const all = this.holds();
    if (!name) {
      if (method === "GET") {
        const unrecorded = [...by.keys()].filter((n) => !all.some((h) => h.name === n)).map((n) => ({ name: n, about: "", where: null, secret: null, recorded: false, ...by.get(n)! }));
        return { status: 200, body: [...all.map(held), ...unrecorded].sort((a, b) => a.name.localeCompare(b.name)) };
      }
      if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      const input = await body();
      if (typeof input.name !== "string" || !LABEL.test(input.name)) throw new Invalid("name must be letters, digits, _ . and -, at most 64");
      if (this.hold(input.name)) throw new Conflict(`there's already a hold ${input.name}`);
      const at = now();
      await this.set(holdRecord(input.name), { about: "", where: null, secret: null, secret_at: null, ...fields(input, at), created: at, updated: at, deleted: null });
      return { status: 201, body: held(shown(this.hold(input.name)!)) };
    }
    if (!LABEL.test(name)) return { status: 404, body: { error: `no hold ${name}` } };
    const h = this.hold(name);
    if (method === "GET") return h ? { status: 200, body: held(shown(h)) } : { status: 404, body: { error: `no hold ${name}` } };
    if (method === "PATCH") {
      if (!h) return { status: 404, body: { error: `no hold ${name}` } };
      const input = await body();
      if (typeof input.updated !== "string") throw new Invalid("updated must be the hold's, as you last read it");
      if (input.updated !== h.updated) throw new Conflict(`${name} changed since; here it is now`, shown(h));
      const at = later(h.updated);
      const f = fields(input, at);
      const to = input.name ?? name;
      if (to !== name) {
        if (typeof to !== "string" || !LABEL.test(to)) throw new Invalid("name must be letters, digits, _ . and -, at most 64");
        if (this.hold(to)) throw new Conflict(`there's already a hold ${to}`);
        const nix = by.get(name)?.templates ?? [];
        if (nix.length) throw new Conflict(`${nix.join(", ")} hold${nix.length === 1 ? "s" : ""} ${name} in its host's Nix config; rename it there first`);
        await this.moveOnBrains(name, to);
        await this.replicas.change(
          "fleet",
          FLEET,
          { t: "card", card: holdRecord(to), set: { about: h.about, where: h.where, secret: h.value, secret_at: h.secret, created: h.created, ...f, updated: at, deleted: null } },
          { t: "card", card: holdRecord(name), set: { deleted: at, secret: null } },
        );
        return { status: 200, body: { ...shown(this.hold(to)!), recorded: true, ...((await this.holders()).get(to) ?? { brains: [], templates: [] }) } };
      }
      await this.set(holdRecord(name), { ...f, updated: at });
      return { status: 200, body: held(shown(this.hold(name)!)) };
    }
    if (method === "DELETE") {
      const holding = by.get(name);
      if (!h && !holding) return { status: 404, body: { error: `no hold ${name}` } };
      if (holding?.templates.length) throw new Conflict(`${holding.templates.join(", ")} hold${holding.templates.length === 1 ? "s" : ""} ${name} in its host's Nix config; take it out there first`);
      await this.moveOnBrains(name, null);
      if (h) await this.set(holdRecord(name), { deleted: now(), secret: null });
      return { status: 204, body: null };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }

  // The Worker's holds, moved here (e2ee move-holds): each record and secret
  // its export has, those not here already.
  async importHolds(d: { records: Record<string, Omit<Hold, "name">>; secrets: Record<string, string> }): Promise<string[]> {
    const moved: string[] = [];
    for (const [name, r] of Object.entries(d.records ?? {})) {
      if (!LABEL.test(name) || this.hold(name)) continue;
      const v = d.secrets?.[name] ?? null;
      await this.set(holdRecord(name), { about: r.about ?? "", where: r.where ?? null, secret: v, secret_at: v === null ? null : (r.secret ?? r.updated), created: r.created, updated: r.updated, deleted: null });
      moved.push(name);
    }
    return moved;
  }
}

const shown = ({ value: _, ...h }: Hold & { value?: string | null }): Hold => h;

function fields(input: Record<string, unknown>, at: string): Record<string, unknown> {
  const f: Record<string, unknown> = {};
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
    f.secret = input.secret;
    f.secret_at = input.secret === null ? null : at;
  }
  return f;
}

const PACKAGE = /^[A-Za-z_][\w.+-]{0,127}$/;
const FLAKE = /^[\w.+:/#?=&@~,%-]{1,512}$/;

// As the Worker's shellOf: a flake ref, or { packages } / { flake }.
export function shellOf(shell: unknown, packages?: unknown): Shell | null {
  let s = shell;
  if (s === undefined || s === null || s === "") s = packages === undefined ? undefined : { packages };
  else if (typeof s === "string") s = { flake: s };
  if (s === undefined) return null;
  const o = s as Record<string, unknown>;
  if (Array.isArray(o.packages)) {
    if (!o.packages.length || o.packages.length > 64) throw new Invalid("packages must be 1 to 64 nixpkgs attribute names");
    const bad = o.packages.find((p) => typeof p !== "string" || !PACKAGE.test(p));
    if (bad !== undefined) throw new Invalid(`${JSON.stringify(bad)} isn't a nixpkgs attribute name`);
    return { packages: o.packages as string[] };
  }
  if (typeof o.flake === "string" && FLAKE.test(o.flake)) return { flake: o.flake };
  throw new Invalid('shell must be a flake ref (".#name" for the repo\'s own) or { packages: [...] }');
}
