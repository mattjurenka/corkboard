// Forgejo Actions, a VM per job (.agent/plans/forge-on-leader.md, piece 6):
// fleetd asks Forgejo for the jobs waiting on this host's labels, and for
// each registers an ephemeral runner and queues a spawn of the manifest's
// actions template, which runs that one job by its handle and powers off
// (fleet/caps/actions.nix). Forgejo forgets an ephemeral runner once it has
// run a job; one that never got its job (cancelled first) is deleted when
// its spawn is over. Nothing runs while nothing waits.
//
// It asks as the user whose runners these are, with an access token of
// theirs (write:user) in Manifest.actions.tokenFile: their repos' jobs, not
// an org's.

import { readFileSync } from "node:fs";
import type { Manifest, Spawn } from "./fleet";

// How often Forgejo is asked.
const EVERY_MS = 10_000;

// A job as Forgejo's job search gives it (ActionRunJob).
export type Job = { id: number; handle?: string; name: string; run_id: number; status: string; runs_on?: string[] };

export type Forgejo = (m: NonNullable<Manifest["actions"]>, method: string, path: string, body?: unknown) => Promise<any>;

export const forgejo: Forgejo = async (a, method, path, body) => {
  const res = await fetch(`${a.url.replace(/\/$/, "")}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `token ${readFileSync(a.tokenFile, "utf8").trim()}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => undefined)) as any;
  // A runner gone already is as good as deleted.
  if (res.status === 404 && method === "DELETE") return undefined;
  if (res.status >= 400) throw new Error(`Forgejo: ${method} ${path}: ${json?.message ?? `HTTP ${res.status}`}`);
  return json;
};

export class Actions {
  private last = -Infinity;
  private problem?: string;

  // save writes a spawn (fleet.ts's write), and id names a new one.
  constructor(
    private api: Forgejo,
    private save: (s: Spawn) => void,
    private id: () => string,
  ) {}

  async step(m: Manifest, all: Spawn[], now = Date.now()) {
    const a = m.actions;
    if (!a) return;
    try {
      // Each one over, its runner gone with it.
      for (const s of all) {
        if (!s.actions || s.actions.gone || s.state === "queued" || s.state === "running") continue;
        await this.api(a, "DELETE", `/user/actions/runners/${s.actions.runner}`);
        const { token: _, ...kept } = s.actions;
        this.save({ ...s, actions: { ...kept, gone: true } });
      }
      if (now - this.last < EVERY_MS) return;
      this.last = now;
      const jobs = ((await this.api(a, "GET", `/user/actions/runners/jobs?${new URLSearchParams({ labels: a.labels.join(",") })}`)) ?? []) as Job[];
      const had = new Set(all.map((s) => s.actions?.handle).filter(Boolean));
      for (const j of jobs) {
        if (!j.handle || had.has(j.handle) || (j.status && j.status !== "waiting")) continue;
        const id = this.id();
        const r = await this.api(a, "POST", "/user/actions/runners", { name: `fleet-${id}`, description: `${j.name} (run ${j.run_id})`, ephemeral: true });
        this.save({
          id,
          template: a.template,
          task: `Forgejo Actions: ${j.name} (run ${j.run_id}, job ${j.id})`,
          by: "actions",
          account: "",
          state: "queued",
          created: new Date(now).toISOString(),
          job: "actions",
          actions: { handle: j.handle, job: j.id, run: j.run_id, runner: r.id, uuid: r.uuid, token: r.token },
        });
        had.add(j.handle);
        console.log(`${id}: Actions job ${j.id} (${j.name}, run ${j.run_id})`);
      }
      this.say(undefined);
    } catch (e) {
      this.say(String((e as Error).message ?? e));
    }
  }

  // Each problem once, not every ten seconds.
  private say(problem?: string) {
    if (problem && problem !== this.problem) console.error(`fleetd: Actions: ${problem}`);
    this.problem = problem;
  }
}
