// fleetd's side of the Worker's queue (cloud/src/fleet.ts): it tells the
// Worker what this environment can run, claims the spawns queued for it,
// and says how each one went. Signed in as the bridge is (bridge/cloud.ts,
// the owner's token); not signed in, fleetd runs the CLI's spawns alone.
//
// It hears of new spawns on the user's live socket (GET /api/live, a
// { type: "spawn" } per change) and looks again every minute besides, so a
// dropped socket costs a minute, not a spawn. A claimed spawn becomes a
// file like the CLI's, with `remote` saying where it came from; from there
// fleetd's tick runs it like any other, and this reports each new state.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";
import { accountFor, answer, manifest, read, SPAWNS, spawns, write, type Manifest, type Spawn, type State } from "./fleet";

export const ENVIRONMENT = process.env.CORKBOARD_FLEET_ENVIRONMENT ?? "local";
const LOOK_EVERY = 60_000;

const now = () => new Date().toISOString();

type Remote = {
  id: string;
  template: string;
  task: string;
  by: string;
  state: "pending-approval" | "queued" | "running" | State;
  stopRequested?: boolean;
};

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

export class Queue {
  private dirty = true;
  private lastLook = 0;
  private ws?: WebSocket;
  private retry = 1000;
  private ping?: ReturnType<typeof setInterval>;
  private offline?: string;

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

  // After fleetd's tick: what changed here goes up, and what's new there
  // comes down.
  async step() {
    try {
      await this.report();
      if (this.dirty || Date.now() - this.lastLook > LOOK_EVERY) {
        this.dirty = false;
        this.lastLook = Date.now();
        await this.look();
      }
      this.say(undefined);
    } catch (e) {
      this.say(String((e as Error).message ?? e));
    }
  }

  // What this environment runs, then the spawns for it: the queued ones
  // claimed, and a stop asked for there passed on here.
  private async look() {
    const m = manifest();
    await ok("PUT", `/api/fleet/environments/${ENVIRONMENT}`, { templates: m.templates });
    const listed = (await ok("GET", `/api/spawns?environment=${ENVIRONMENT}&state=queued,running,stopped&limit=100`)) as Remote[];
    for (const r of listed) {
      const here = read(r.id);
      if (!here && r.state === "queued") await this.claim(m, r);
      else if (here && (here.state === "queued" || here.state === "running") && (r.stopRequested || r.state === "stopped") && !here.stopRequested)
        write({ ...here, stopRequested: true });
    }
  }

  private async claim(m: Manifest, r: Remote) {
    const c = await api("POST", `/api/spawns/${r.id}/claim`, { environment: ENVIRONMENT });
    // Taken already, or no longer queued: nothing to do.
    if (c.status === 409) return;
    if (c.status >= 400) throw new Error(`claiming ${r.id}: ${c.json.error ?? c.status}`);
    const { spawn, token: cardToken, repo } = c.json as { spawn: Remote & { board: string; card: string; agent: string }; token: string; repo: string | null };
    const s: Spawn = {
      id: spawn.id,
      template: spawn.template,
      task: spawn.task,
      repo: repo && existsSync(join(repo, ".git")) ? repo : undefined,
      by: spawn.by,
      account: "",
      state: "queued",
      created: now(),
      remote: { board: spawn.board, card: spawn.card, agent: spawn.agent, token: cardToken },
    };
    try {
      s.account = accountFor(m, s.template, s.by);
      write(s);
      console.log(`${s.id}: claimed ${s.template} from the queue (card ${s.remote!.card} on ${s.remote!.board})`);
    } catch (e) {
      write({ ...s, state: "failed", error: String((e as Error).message ?? e), ended: now() });
    }
  }

  // Each spawn from the queue whose state the Worker hasn't heard yet. One
  // that's over has its commits fetched into its repo first (as fleet/<id>),
  // and its token revoked after.
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
      const r = await api("POST", `/api/spawns/${s.id}/report`, {
        state: s.state,
        slot: s.slot,
        exit: s.exit,
        error: s.error,
        result: result.trim() || undefined,
      });
      if (r.status >= 400 && r.status !== 409) throw new Error(`reporting ${s.id}: ${r.json.error ?? r.status}`);
      const remote = over ? { ...s.remote, token: "" } : s.remote;
      if (over && s.remote.token) await api("POST", "/api/tokens/revoke", { token: s.remote.token }).catch(() => {});
      write({ ...read(s.id)!, reported: s.state, remote });
    }
  }
}
