// Forgejo Actions: a waiting job becomes a spawn with an ephemeral runner
// of its own, once, and the runner goes when the spawn is over.   bun test fleet/fleetd
import { expect, test } from "bun:test";
import { Actions, type Forgejo, type Job } from "./actions";
import type { Manifest, Spawn } from "./fleet";

const m = { actions: { url: "https://git.test", tokenFile: "/dev/null", labels: ["droplet"], template: "ci" } } as unknown as Manifest;

function forgejo(jobs: Job[]) {
  const calls: string[] = [];
  let n = 0;
  const api: Forgejo = async (_, method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET") return jobs;
    if (method === "POST") return { id: ++n, uuid: `uuid-${n}`, token: `tok-${n}`, ...(body as object) };
  };
  return { api, calls };
}

test("a waiting job is queued once, with its own ephemeral runner", async () => {
  const f = forgejo([
    { id: 7, handle: "h7", name: "build", run_id: 3, status: "waiting", runs_on: ["droplet"] },
    { id: 8, handle: "h8", name: "test", run_id: 3, status: "running" },
  ]);
  const saved: Spawn[] = [];
  const a = new Actions(f.api, (s) => saved.push(s), () => "s" + Math.random());
  await a.step(m, [], 0);
  expect(f.calls).toEqual(["GET /user/actions/runners/jobs?labels=droplet", "POST /user/actions/runners"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ template: "ci", job: "actions", state: "queued", account: "", actions: { handle: "h7", job: 7, run: 3, runner: 1, uuid: "uuid-1", token: "tok-1" } });

  // Asked again, with the spawn on disk: nothing new.
  await a.step(m, saved, 60_000);
  expect(saved).toHaveLength(1);
  expect(f.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
});

test("not asked again sooner than every ten seconds", async () => {
  const f = forgejo([]);
  const a = new Actions(f.api, () => {}, () => "s" + Math.random());
  await a.step(m, [], 0);
  await a.step(m, [], 5_000);
  expect(f.calls).toHaveLength(1);
});

test("a spawn that's over has its runner deleted, and its token dropped", async () => {
  const f = forgejo([]);
  const saved: Spawn[] = [];
  const a = new Actions(f.api, (s) => saved.push(s), () => "s" + Math.random());
  const base = { template: "ci", task: "", by: "actions", account: "", created: "", job: "actions" as const };
  const all: Spawn[] = [
    { ...base, id: "a", state: "done", actions: { handle: "h", job: 1, run: 1, runner: 5, uuid: "u", token: "t" } },
    { ...base, id: "b", state: "running", actions: { handle: "i", job: 2, run: 1, runner: 6, uuid: "u", token: "t" } },
    { ...base, id: "c", state: "failed", actions: { handle: "j", job: 3, run: 1, runner: 7, uuid: "u", gone: true } },
  ];
  await a.step(m, all, 0);
  expect(f.calls[0]).toBe("DELETE /user/actions/runners/5");
  expect(f.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  expect(saved).toEqual([{ ...all[0], actions: { handle: "h", job: 1, run: 1, runner: 5, uuid: "u", gone: true } }]);
});

test("no actions in the manifest, nothing asked", async () => {
  const f = forgejo([]);
  await new Actions(f.api, () => {}, () => "s").step({} as Manifest, [], 0);
  expect(f.calls).toHaveLength(0);
});
