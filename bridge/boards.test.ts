import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloud } from "./cloud-session";
import { ENVIRONMENT, Session, USER, useNode } from "./boards";
import type { AppNode } from "./node/app";

// The Worker, for what the node doesn't answer: each request it's asked.
const asked: { method: string; path: string; body: any }[] = [];
const worker = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    asked.push({ method: req.method, path: url.pathname + url.search, body });
    if (url.pathname === "/api/fleet/environments") return Response.json([{ name: "laptop" }]);
    if (url.pathname === "/api/spawns" && req.method === "GET") return Response.json([]);
    if (url.pathname === "/api/sessions") return Response.json([]);
    if (url.pathname === "/api/spawns") return Response.json({ id: "s-worker" });
    if (url.pathname.startsWith("/api/brains") || url.pathname === "/api/notes") return Response.json([{ name: "from-worker" }]);
    return Response.json({ error: `no route ${url.pathname}` }, { status: 404 });
  },
});
const dir = mkdtempSync(join(tmpdir(), "corkboard-boards-"));
afterAll(() => {
  worker.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
const cloud = () =>
  new Cloud({
    cloud: `http://127.0.0.1:${worker.port}`,
    token: async () => "tok",
    socket: (url) => new WebSocket(url),
    environment: ENVIRONMENT,
    remotes: async () => [],
    machine: () => null,
    self: () => undefined,
  });

// The bridge's node, as boards.ts asks it: what each was asked, and the
// listeners it was given.
function fakeNode() {
  const calls: [string, string, any[]][] = [];
  const board: ((key: string, event: unknown) => void)[] = [];
  const day: ((event: unknown) => void)[] = [];
  const n = {
    calls,
    board,
    day,
    nodes: async (op: string, args: any[]) => (calls.push(["nodes", op, args]), { op }),
    notes: async (op: string, args: any[]) => (calls.push(["notes", op, args]), { op }),
    boards: async (op: string, args: any[]) => (calls.push(["boards", op, args]), op === "resolve" ? (args[0] === "known" ? "proj" : null) : op === "subscribe" && args[0] === "gone" ? null : { op }),
    plans: async (op: string, args: any[]) => (calls.push(["plans", op, args]), { op }),
    fleet: async (op: string, args: any[]) => (calls.push(["fleet", op, args]), op === "fleet_open" ? { opened: args[0] } : undefined),
    brains: async (op: string, args: any[]) => (calls.push(["brains", op, args]), op === "brains_notes" ? ["here"] : undefined),
    onBoard: (fn: (key: string, event: unknown) => void) => (board.push(fn), () => board.splice(board.indexOf(fn), 1)),
    onDay: (fn: (event: unknown) => void) => (day.push(fn), () => day.splice(day.indexOf(fn), 1)),
  };
  return n;
}

describe("a Neovim's cloud operations, on the bridge", () => {
  it("say there's no node to ask when the bridge has none", async () => {
    const s = new Session(() => {}, undefined, cloud());
    expect(await s.call("nodes_list", [])).toBeNull();
    for (const op of ["pr_merge", "pr_review", "git_forge", "git_files"]) await expect(s.call(op, [])).rejects.toThrow("there's no node here to reach the forge through");
    // The rest goes to the Worker.
    expect(await s.call("brains_notes", ["pepper"])).toEqual([{ name: "from-worker" }]);
  });

  it("go to the node: its devices, notes, plans and boards, and the brains it has", async () => {
    const n = fakeNode();
    useNode(n as unknown as AppNode);
    const got: [string, unknown][] = [];
    const s = new Session((k, e) => void got.push([k, e]), undefined, cloud());
    expect(await s.call("nodes_list", [1])).toEqual({ op: "nodes_list" });
    expect(await s.call("note_get", ["usage"])).toEqual({ op: "note_get" });
    expect(await s.call("goals", [])).toEqual({ op: "goals" });
    expect(await s.call("plan_get", ["2026-11-20"])).toEqual({ op: "plan_get" });
    // A plan's boards are the node's boards.
    expect(await s.call("plan_boards", [])).toEqual({ op: "boards" });
    expect(await s.call("brains_notes", ["pepper"])).toEqual(["here"]);
    // A brains op the node doesn't answer is the Worker's.
    asked.length = 0;
    expect(await s.call("brains_create", [{ name: "new" }])).toEqual([{ name: "from-worker" }]);
    expect(asked.map((a) => [a.method, a.path])).toEqual([["POST", "/api/brains"]]);
    expect(await s.call("resolve", ["known", "abc"])).toBe("proj");
    // A path the node has no board for is its own key.
    expect(await s.call("resolve", ["home-me-new", "abc"])).toBe("home-me-new");
    expect(n.calls.map(([w, op]) => `${w}.${op}`)).toEqual(["nodes.nodes_list", "notes.note_get", "notes.goals", "plans.plan_get", "boards.boards", "brains.brains_notes", "brains.brains_create", "boards.resolve", "boards.resolve"]);
    s.close();
  });

  it("follow the node's boards it subscribes to, with the clone's place and remotes, and stop on close", async () => {
    const n = fakeNode();
    useNode(n as unknown as AppNode);
    // A clone with remotes: origin first, no credentials, no local paths.
    const repo = join(dir, "clone");
    for (const args of [
      ["init", "-q", repo],
      ["-C", repo, "remote", "add", "upstream", "git@github.com:them/proj.git"],
      ["-C", repo, "remote", "add", "origin", "https://me:secret@git.test/me/proj.git"],
      ["-C", repo, "remote", "add", "local", "/home/me/elsewhere"],
    ])
      expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
    const got: [string, unknown][] = [];
    const s = new Session((k, e) => void got.push([k, e]), undefined, cloud());
    expect(await s.call("subscribe", ["proj", "Proj", repo, false, "c0ffee"])).toEqual({ op: "subscribe" });
    const [, , [key, name, place, make]] = n.calls.at(-1)!;
    expect([key, name, make]).toEqual(["proj", "Proj", false]);
    expect(place).toEqual({ root: repo, environment: ENVIRONMENT, commit: "c0ffee", remotes: ["https://git.test/me/proj.git", "git@github.com:them/proj.git"] });
    // make: made, though it says make false.
    await s.call("make", ["other", "Other"]);
    expect(n.calls.at(-1)).toEqual(["boards", "make", ["other", "Other", { root: null, environment: ENVIRONMENT }, true]]);
    // A board the node hasn't got isn't followed.
    expect(await s.call("subscribe", ["gone", "Gone"])).toBeNull();
    expect(n.board).toHaveLength(1);
    for (const fn of n.board) {
      fn("proj", { type: "card" });
      fn("gone", { type: "card" });
      fn("other", { type: "card" });
    }
    expect(got).toEqual([["proj", { type: "card" }]]);
    // Its day plan's events, as the user socket's.
    await s.call("plan_subscribe", []);
    await s.call("plan_subscribe", []);
    expect(n.day).toHaveLength(1);
    n.day[0]({ type: "plan" });
    expect(got.at(-1)).toEqual([USER, { type: "plan" }]);
    s.close();
    expect(n.board).toHaveLength(0);
    expect(n.day).toHaveLength(0);
  });

  it("queue a session on a board with the node's grant, the Worker's when the node doesn't, and open what the node keeps sealed", async () => {
    const n = fakeNode();
    useNode(n as unknown as AppNode);
    const s = new Session(() => {}, undefined, cloud());
    asked.length = 0;
    expect(await s.call("fleet_session", ["laptop", "claude", "proj"])).toEqual({ id: "s-worker" });
    expect(n.calls[0]).toEqual(["fleet", "fleet_session", ["laptop", "claude", "proj", true]]);
    expect(asked.at(-1)!.body).toMatchObject({ board: "proj", node: true });
    // No board: as it was asked.
    await s.call("fleet_session", ["laptop", "claude"]);
    expect(n.calls[1]).toEqual(["fleet", "fleet_session", ["laptop", "claude"]]);
    const got = (await s.call("fleet_get", [])) as { opened: { environments: unknown } };
    expect(got.opened.environments).toEqual([{ name: "laptop" }]);
    // A board op with no board isn't the node's, and the Worker's says so.
    await expect(s.call("create", ["", {}])).rejects.toThrow("no board key");
  });
});
