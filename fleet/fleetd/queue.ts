// fleetd's side of the Worker's queue (its fleet.ts): it tells the
// Worker what this environment can run, claims the spawns queued for it,
// and says how each one went. Signed in as the bridge is (bridge/cloud.ts,
// the owner's token); not signed in, fleetd runs the CLI's spawns alone.
//
// It hears of new spawns on the user's live socket (GET /api/live, a
// { type: "spawn" } per change) and looks again every minute besides, so a
// dropped socket costs a minute, not a spawn. A claimed spawn becomes a
// file like the CLI's, with `remote` saying where it came from; from there
// fleetd's tick runs it like any other, and this reports each new state.
//
// A spawn on a board the user's node keeps (the Worker's `node`, .agent/
// plans/local-boards.md) is the node's to equip: its card or session
// grant, its repo (the board's root here) and its brain's memory come from
// the node's API (Manifest.node, node.ts), and how it goes is
// written on its card there, as the Worker writes on its own boards' cards.
//
// With a device of its own on the node (Manifest.node.device, a sealed
// channel: .agent/plans/ciphertext-relay.md, step 4), the environment is
// sealed: its whole manifest goes to the node's fleet object and the Worker
// has only its templates and offer, and a sealed spawn's task, shell and
// the secrets it holds are read from the node at its claim, its result and
// error written back there; the Worker hears only its state.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";
import { host, steady, type Host } from "../../bridge/host";
import { type Git, newHolder } from "./forge";
import { nodeFetch } from "./node";
import { accountFor, answer, egressOf, manifest, occupancy, OVERHEAD, read, SPAWNS, spawns, write, type Manifest, type Occupancy, type Spawn, type State } from "./fleet";

// This machine's name, unless told otherwise.
export const ENVIRONMENT = process.env.CORKBOARD_FLEET_ENVIRONMENT ?? hostname();
const LOOK_EVERY = 60_000;
// How often the machine's busyness goes up when nothing else has changed:
// the fleet view's resources are no staler than this.
const TELL_EVERY = 15_000;

const now = () => new Date().toISOString();

type Remote = {
  id: string;
  template: string;
  task: string;
  by: string;
  brain?: string | null;
  account?: string | null;
  state: "pending-approval" | "queued" | "running" | State;
  stopRequested?: boolean;
  board?: string | null;
  card?: string | null;
  agent?: string;
  node?: true;
  sealed?: true;
  created?: string;
};

// As the Worker cuts a spawn's result.
const RESULT = 8000;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${CLOUD}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function ok(method: string, path: string, body?: unknown) {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.json.error ?? `HTTP ${r.status}`}`);
  return r.json;
}

// The node's API, as its owner (node.ts).
export async function nodeApi(m: Manifest, method: string, path: string, body?: unknown): Promise<any> {
  if (!m.node) throw new Error("its board is the node's, and this host's manifest names no node");
  const res = await nodeFetch(m.node, `/api/node${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (res.status >= 400) throw new Error(`the node: ${method} ${path}: ${json.error ?? `HTTP ${res.status}`}`);
  return json;
}

const cardPath = (r: { board: string | null; card: string | null }) => `/boards/${encodeURIComponent(r.board!)}/cards/${encodeURIComponent(r.card!)}`;

// A line on a spawn's card on the node, and the card moved along with it
// (the Worker's onCard). The agent may have moved it itself; this never
// moves it back. A session has none.
async function onCard(m: Manifest, r: NonNullable<Spawn["remote"]>, note: string, fn?: (c: any) => Record<string, unknown>) {
  if (!r.card || !r.board) return;
  await nodeApi(m, "POST", `${cardPath(r)}/log`, { note, who: "fleet" });
  if (!fn) return;
  const fields = fn(await nodeApi(m, "GET", cardPath(r)));
  if (Object.keys(fields).length) await nodeApi(m, "PATCH", cardPath(r), fields);
}

// A stopped spawn lets go of its card, unless someone else has taken it since.
const letGo = (r: { agent?: string }, c: any) => (c.agent === r.agent ? { agent: null } : {});

// What a state says on the card, as the Worker's report says it.
async function cardSays(m: Manifest, s: Spawn, result: string) {
  const r = s.remote!;
  const failure = s.error ?? `exit ${s.exit ?? "?"}`;
  const cut = result.length > RESULT ? result.slice(0, RESULT - 1) + "…" : result;
  if (s.state === "running") await onCard(m, r, `running${s.slot ? ` in ${s.slot}` : ""} (${ENVIRONMENT})`);
  else if (s.state === "done")
    await onCard(m, r, `done${cut ? `:\n${cut}` : ""}`, (c) => (c.status === "done" || c.status === "review" ? {} : { status: "review", agent_state: "needs-review" }));
  else if (s.state === "failed")
    await onCard(m, r, `failed: ${failure}${cut ? `\n${cut}` : ""}`, (c) => (c.status === "done" ? {} : { attention: `spawn failed: ${failure.split("\n")[0].slice(0, 160)}` }));
  else if (s.state === "stopped") await onCard(m, r, "stopped", (c) => (c.status === "done" ? {} : { ...letGo(r, c), agent_state: null }));
}

const told = (r: Occupancy & { host?: Host }) => JSON.stringify({ ...r, host: steady(r.host) });

export class Queue {
  private dirty = true;
  private lastLook = 0;
  private ws?: WebSocket;
  private retry = 1000;
  private ping?: ReturnType<typeof setInterval>;
  private offline?: string;
  // What runs here, and what the Worker was last told of it. This machine
  // goes with it, and only a change other than its load, free memory and
  // uptime is told at once.
  private running?: Occupancy & { host?: Host };
  private told?: string;
  // What the node was last told of this environment, sealed.
  private nodeTold?: string;
  // Sealed spawns whose words the node hasn't given yet, said once each.
  private unopened = new Set<string>();

  start() {
    void this.connect();
  }

  private async connect() {
    try {
      const ws = new WebSocket(`${CLOUD.replace(/^http/, "ws")}/api/live`, { headers: { Authorization: `Bearer ${await token()}` } } as any);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 1000;
        this.dirty = true;
        this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
        console.log(`fleetd: following the queue at ${CLOUD} as ${ENVIRONMENT}`);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        try {
          const event = JSON.parse(String(e.data));
          if (event.type === "spawn" && event.spawn?.environment === ENVIRONMENT) this.dirty = true;
        } catch {}
      };
      ws.onclose = () => {
        clearInterval(this.ping);
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, LOOK_EVERY);
      };
    } catch (e) {
      this.say(String((e as Error).message ?? e));
      setTimeout(() => this.connect(), LOOK_EVERY);
    }
  }

  // Each problem once, not every two seconds.
  private say(problem?: string) {
    if (problem && problem !== this.offline) console.error(`fleetd: the queue: ${problem}`);
    this.offline = problem;
  }

  // After fleetd's tick, with the units that are up: what changed here goes
  // up, and what's new there comes down. A change in what runs here is told
  // at once, for the fleet view.
  async step(active?: Set<string>) {
    try {
      if (active) this.running = { ...occupancy(manifest(), spawns(), active), host: host() };
      if (this.running && told(this.running) !== this.told) this.dirty = true;
      await this.report();
      if (this.dirty || Date.now() - this.lastLook > TELL_EVERY) {
        this.dirty = false;
        this.lastLook = Date.now();
        await this.look();
      }
      this.say(undefined);
    } catch (e) {
      this.say(String((e as Error).message ?? e));
    }
  }

  // What this environment runs (its templates, what its slots may reach,
  // the brains it has memory for), then the spawns for it: the queued ones
  // claimed, and a stop asked for there passed on here.
  private async look() {
    const m = manifest();
    const running = this.running;
    // As the manifest has them: one still a brain's (a manifest from before
    // brains were spawns') the Worker won't offer.
    const said = {
      templates: m.templates,
      offer: m.offer ?? { memory: m.memoryBudget && m.memoryBudget - OVERHEAD, cores: null },
      egress: egressOf(m),
      bindings: Object.keys(m.bindings ?? {}),
      // What its guests run instead of an agent (fleet/guest/slot.nix).
      jobs: ["consolidate"],
      running,
    };
    const sealed = !!m.node?.device;
    if (sealed) {
      // Each change but its load's, as the Worker broadcast them: the node
      // keeps every one.
      const kept = JSON.stringify({ ...said, running: running && { ...running, host: steady(running.host) } });
      if (kept !== this.nodeTold) {
        await nodeApi(m, "PUT", `/fleet/environments/${ENVIRONMENT}`, { manifest: said });
        this.nodeTold = kept;
      } else if (running) {
        // Its load, for the fleet views; a node from before this has no such route.
        await nodeApi(m, "PUT", `/fleet/environments/${ENVIRONMENT}/running`, { running }).catch(() => {});
      }
    }
    const { egress, running: _, ...open } = said;
    await ok("PUT", `/api/fleet/environments/${ENVIRONMENT}`, sealed ? { ...open, sealed: true } : said);
    this.told = running && told(running);
    const listed = (await ok("GET", `/api/spawns?environment=${ENVIRONMENT}&state=queued,running,stopped&limit=100`)) as Remote[];
    for (const r of listed) {
      const here = read(r.id);
      if (!here && r.state === "queued") await this.claim(m, r);
      else if (!here && r.state === "stopped" && r.node) await this.stoppedFirst(m, r);
      else if (here && (here.state === "queued" || here.state === "running") && (r.stopRequested || r.state === "stopped") && !here.stopRequested)
        write({ ...here, stopRequested: true });
    }
  }

  // One on the node's board stopped before it was claimed: its card let go
  // of, and kept here as over, so it's said once.
  private async stoppedFirst(m: Manifest, r: Remote) {
    const remote = { board: r.board ?? null, card: r.card ?? null, agent: r.agent ?? "", token: null, node: true as const };
    await onCard(m, remote, "stopped before it ran", (c) => (c.status === "done" ? {} : { ...letGo(remote, c), agent_state: null, attention: null, status: "backlog" }));
    write({ id: r.id, template: r.template, task: r.task, by: r.by, account: "", state: "stopped", created: r.created ?? now(), ended: now(), reported: "stopped", carded: "stopped", remote });
  }

  private async claim(m: Manifest, r: Remote) {
    const c = await api("POST", `/api/spawns/${r.id}/claim`, { environment: ENVIRONMENT });
    // Taken already, or no longer queued: nothing to do.
    if (c.status === 409) return;
    if (c.status >= 400) throw new Error(`claiming ${r.id}: ${c.json.error ?? c.status}`);
    const { spawn, token: cardToken, repo, brainToken, holds } = c.json as {
      spawn: Remote & { board: string | null; card: string | null; agent: string; interactive?: boolean; node?: true } & Pick<Spawn, "shell" | "memory" | "cores" | "job">;
      token: string | null;
      repo: string | null;
      brainToken?: string;
      secrets?: Record<string, string>;
      holds?: string[];
    };
    let { secrets } = c.json as { secrets?: Record<string, string> };
    // Its words, from the node. One the node can't give yet stays claimed
    // and unwritten here, and is claimed again at the next look; with no
    // node to ask, it fails rather than wait for one.
    // A template that names repos gets a key of its own, which the node
    // signs a grant to (forge.ts).
    let git: Git | undefined;
    if (spawn.sealed && m.node) {
      let words: { task: string; shell: Spawn["shell"] | null; secrets?: Record<string, string>; git?: Omit<Git, "key"> };
      const holder = m.templates[spawn.template]?.git ? newHolder() : undefined;
      const q = new URLSearchParams();
      if (holds?.length) q.set("holds", holds.join(","));
      if (holder) q.set("git", holder.id), q.set("environment", ENVIRONMENT);
      try {
        words = await nodeApi(m, "GET", `/fleet/spawns/${spawn.id}${q.size ? `?${q}` : ""}`);
      } catch (e) {
        if (!this.unopened.has(spawn.id)) console.error(`${spawn.id}: its words: ${(e as Error).message}`);
        this.unopened.add(spawn.id);
        return;
      }
      this.unopened.delete(spawn.id);
      spawn.task = words.task;
      if (words.shell) spawn.shell = words.shell;
      else delete spawn.shell;
      secrets = words.secrets && Object.keys(words.secrets).length ? words.secrets : undefined;
      if (holder && words.git) git = { ...words.git, key: holder.key };
    }
    const s: Spawn = {
      id: spawn.id,
      template: spawn.template,
      task: spawn.task,
      repo: repo && existsSync(join(repo, ".git")) ? repo : undefined,
      by: spawn.by,
      ...(spawn.brain && { brain: spawn.brain }),
      account: "",
      state: "queued",
      created: now(),
      remote: { board: spawn.board, card: spawn.card, agent: spawn.agent, token: cardToken, ...(brainToken && { brainToken }), ...(secrets && { secrets }), ...(git && { git }), ...(spawn.sealed && { sealed: true as const }) },
      ...(spawn.interactive && { interactive: true }),
      ...(spawn.shell && { shell: spawn.shell }),
      ...(spawn.memory && { memory: spawn.memory }),
      ...(spawn.cores && { cores: spawn.cores }),
      ...(spawn.job && { job: spawn.job }),
    };
    try {
      if ((spawn.sealed || spawn.node) && !m.node) throw new Error("its board is the node's, and this host's manifest names no node");
      // The Worker's rule, which it can't see on a sealed spawn: a shell of the
      // spawner's never goes beside a brain's memory.
      if (spawn.sealed && s.shell && s.brain) throw new Error(`a shell of your own never goes beside the ${s.brain} brain's memory`);
      if (spawn.node) await this.equip(m, s, spawn);
      s.account = accountFor(m, spawn.account);
      write(s);
      console.log(`${s.id}: claimed ${s.template} from the queue (${s.remote!.card ? `card ${s.remote!.card} on ${s.remote!.board}` : s.remote!.board ? `a session on ${s.remote!.board}` : "no board"})`);
    } catch (e) {
      write({ ...s, state: "failed", error: String((e as Error).message ?? e), ended: now() });
    }
  }

  // A spawn on the node's board, given what the Worker didn't: its grant
  // and repo from the node, and the brain's memory there (not a job's: the
  // Worker's consolidator is the Worker's). The approval its card waited on
  // is over, since it's queued.
  private async equip(m: Manifest, s: Spawn, spawn: { id: string; board: string | null; card: string | null; agent: string }) {
    const r = s.remote!;
    r.node = true;
    if (spawn.board) {
      const g = await nodeApi(m, "POST", "/grants", spawn.card ? { scope: "card", board: spawn.board, card: spawn.card, agent: spawn.agent } : { scope: "session", board: spawn.board, spawn: spawn.id, agent: spawn.agent });
      r.token = g.token;
      r.mcp = g.url;
      const b = await nodeApi(m, "GET", `/boards/${encodeURIComponent(spawn.board)}`);
      const root = b.roots?.[ENVIRONMENT] ?? b.root;
      if (typeof root === "string" && existsSync(join(root, ".git"))) s.repo = root;
      if (spawn.card && String((await nodeApi(m, "GET", cardPath(r))).attention ?? "").startsWith("approve:")) await onCard(m, r, "approved", () => ({ attention: null }));
    }
    if (s.brain && !s.job && m.node) {
      const g = await nodeApi(m, "POST", "/grants", { scope: "brain", brain: s.brain, agent: spawn.agent }).catch((e) => void console.error(`${s.id}: the brain's memory: ${(e as Error).message}`));
      if (g) {
        if (r.brainToken) await api("POST", "/api/tokens/revoke", { token: r.brainToken }).catch(() => {});
        r.brainToken = g.token;
        r.memory = g.url;
      }
    }
  }

  // Each spawn from the queue whose state the Worker hasn't heard yet. One
  // that's over has its commits fetched into its repo first (as fleet/<id>),
  // and its tokens revoked after.
  private async report() {
    for (const s of spawns()) {
      if (!s.remote || s.state === "queued" || s.reported === s.state) continue;
      const over = s.state !== "running";
      let note = "";
      if (over && s.repo && existsSync(join(SPAWNS, s.id, "work.bundle")) && !s.fetched) {
        const p = Bun.spawn(["git", "-C", s.repo, "fetch", "--quiet", join(SPAWNS, s.id, "work.bundle"), `fleet-result:fleet/${s.id}`], { stderr: "pipe" });
        if ((await p.exited) === 0) {
          s.fetched = `fleet/${s.id}`;
          write({ ...read(s.id)!, fetched: s.fetched });
        } else note = `\n\n(its commits didn't fetch: ${(await new Response(p.stderr).text()).trim()})`;
      }
      const result = (answer(s) ?? "") + (s.fetched ? `\n\nIts commits: branch ${s.fetched} in ${s.repo}.` : "") + note;
      if (s.remote.node && s.carded !== s.state) {
        await cardSays(manifest(), s, result.trim());
        write({ ...read(s.id)!, carded: s.state });
      }
      // A sealed one's go to the node; with none, it never ran, and only
      // why goes to the Worker.
      const words = { error: s.error, result: result.trim() || undefined };
      const sealed = s.remote.sealed && !!manifest().node;
      if (sealed && (words.error || words.result)) await nodeApi(manifest(), "PUT", `/fleet/spawns/${s.id}`, words);
      const r = await api("POST", `/api/spawns/${s.id}/report`, {
        state: s.state,
        slot: s.slot,
        exit: s.exit,
        ...(!sealed && words),
      });
      // 404: the Worker has forgotten it, so there's no one to tell, and it mustn't hold up the rest.
      if (r.status === 404) console.error(`fleetd: ${s.id}: the queue has no such spawn; it's taken as told`);
      else if (r.status >= 400 && r.status !== 409) throw new Error(`reporting ${s.id}: ${r.json.error ?? r.status}`);
      if (over && s.remote.git) await nodeApi(manifest(), "DELETE", `/fleet/spawns/${s.id}/git`).catch((e) => console.error(`${s.id}: its git grant: ${(e as Error).message}`));
      const { secrets: _, git: __, ...kept } = s.remote;
      const remote = over ? { ...kept, token: null, ...(s.remote.brainToken !== undefined && { brainToken: "" }) } : s.remote;
      if (over)
        for (const [t, node] of [
          [s.remote.token, s.remote.node],
          [s.remote.brainToken, s.remote.memory],
        ] as const)
          if (t) await (node ? nodeApi(manifest(), "DELETE", "/grants", { token: t }) : api("POST", "/api/tokens/revoke", { token: t })).catch(() => {});
      write({ ...read(s.id)!, reported: s.state, remote });
    }
  }
}
