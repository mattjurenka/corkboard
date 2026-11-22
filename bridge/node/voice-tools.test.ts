import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hub } from "../hub";
import { Confirms } from "./confirm";
import type { Fleet, Sessions } from "./mcp";
import { ORIGIN, rpc, setup, toolText } from "./testing";

// Away mode's sessions and the fleet over the node's /mcp, for a resident
// (Pepper) as for the user's own clients (.agent/plans/voice-call.md step 3):
// a resident reads them, and what it would write waits for the user's yes.
describe("the account's sessions, and a resident's writes held for the user", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let now = Date.now();
  const confirms = new Confirms(() => now);
  // A bridge on the laptop, joined to a hub, answering as Neovim would.
  const hub = new Hub();
  const said: Record<string, unknown>[] = [];
  const j = hub.join({ id: "laptop-8080", machine: "laptop" }, (m: any) => {
    if (m.type === "screen") j.receive({ type: "answer", ask: m.ask, lines: ["> fix the bug", "", "Allow git push?  1. Yes  2. No", "", ""] });
    else if (m.type === "say") {
      said.push(m);
      j.receive({ type: "answer", ask: m.ask });
    }
  });
  j.receive({ type: "sessions", sessions: [{ key: "3-12", project: "corkboard", name: "Claude Code", state: "permission", since: 1_700_000_000_000, detail: "Bash: git push" }, { key: "3-14", project: "pepper", state: "" }] });
  const sessions: Sessions = {
    list: () => hub.bridges().map((b) => ({ ...b, device: "laptop" })),
    fetch: async (_, path, init) => (await hub.serve(new Request(`http://node.invalid${path}`, init))) ?? Response.json({ error: "not found" }, { status: 404 }),
  };
  const spawned: { path: string; body?: any }[] = [];
  const fleet: Fleet = async (_, path, body?: any) => {
    spawned.push({ path, body });
    return path === "/spawns" ? { id: "sp1", template: "coding", environment: "droplet", agent: "fleet-sp1", state: "queued" } : {};
  };
  let pepper: string;
  let phone: string;
  beforeAll(async () => {
    n = await setup({ fleet, sessions, confirms });
    pepper = n.oauth.mint("pepper for pepper", 1, "assistant", "assistant", true);
    phone = n.oauth.mint("phone", 1);
  });
  afterAll(() => n.stop());
  const tool = (token: string) => async (name: string, args: Record<string, unknown> = {}) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, token)));
  const names = async (token: string) => ((await (await n.call("/mcp", rpc("tools/list", {}, token))).json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  const api = (token: string, path: string, init: RequestInit = {}) =>
    n.call(`/api/node/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

  it("lists every session with a state, each by its bridge and key", async () => {
    const list = JSON.parse((await tool(pepper)("sessions_list")).text);
    expect(list).toEqual([
      { bridge: "laptop-8080", key: "3-12", machine: "laptop", project: "corkboard", name: "Claude Code", state: "permission", since: new Date(1_700_000_000_000).toISOString(), detail: "Bash: git push" },
    ]);
  });

  it("reads a session's screen, its trailing blank lines gone, at once", async () => {
    expect((await tool(pepper)("session_screen", { bridge: "laptop-8080", key: "3-12" })).text).toBe("> fix the bug\n\nAllow git push?  1. Yes  2. No");
    const gone = await tool(pepper)("session_screen", { bridge: "desk-1", key: "1-1" });
    expect(gone).toMatchObject({ error: true, text: "bridge desk-1 isn't connected" });
  });

  it("holds a resident's typing in the node's words until the user says yes, which runs it once", async () => {
    const out = JSON.parse((await tool(pepper)("session_say", { bridge: "laptop-8080", key: "3-12", text: "1", keys: ["enter"] })).text);
    expect(out.waiting).toContain('"type "1" and press enter in corkboard on laptop"');
    expect(said).toHaveLength(0);
    expect(await (await api(phone, "confirms")).json()).toMatchObject([{ id: out.confirm, agent: "assistant", tool: "session_say", what: 'type "1" and press enter in corkboard on laptop', state: "waiting" }]);
    expect(JSON.parse((await tool(pepper)("confirm_status", { id: out.confirm })).text).state).toBe("waiting");

    const yes = await api(phone, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: true }) });
    expect(await yes.json()).toMatchObject({ state: "done", result: { ok: true } });
    expect(said).toEqual([expect.objectContaining({ type: "say", key: "3-12", text: "1", keys: ["enter"] })]);
    expect(JSON.parse((await tool(pepper)("confirm_status", { id: out.confirm })).text).state).toBe("done");
    // Not twice.
    expect((await api(phone, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: true }) })).status).toBe(400);
    expect(said).toHaveLength(1);
  });

  it("never lets the resident decide, and a no runs nothing", async () => {
    const out = JSON.parse((await tool(pepper)("session_answer", { bridge: "laptop-8080", key: "3-12", answers: [{ picks: [0] }] })).text);
    expect((await api(pepper, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: true }) })).status).toBe(403);
    expect((await api(pepper, "confirms")).status).toBe(403);
    expect(await (await api(phone, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: false }) })).json()).toMatchObject({ state: "refused" });
    expect(said).toHaveLength(1);
  });

  it("refuses a write to a session that isn't there, or with keys Claude Code hasn't, before asking anyone", async () => {
    expect((await tool(pepper)("session_say", { bridge: "laptop-8080", key: "9-9", text: "hi" })).text).toBe("no session 9-9 on laptop-8080; sessions_list lists them");
    expect((await tool(pepper)("session_say", { bridge: "laptop-8080", key: "3-12", keys: ["f12"] })).error).toBe(true);
    expect((await tool(pepper)("session_say", { bridge: "laptop-8080", key: "3-12" })).text).toBe("say something: text, keys or both");
    expect(confirms.waiting()).toHaveLength(0);
  });

  it("holds a resident's spawns too, but not its spawn_status", async () => {
    const out = JSON.parse((await tool(pepper)("start_session", { board: "proj", message: "look at the flaky test" })).text);
    expect(confirms.get(out.confirm)!.what).toBe("start a session on proj, saying: look at the flaky test");
    expect(spawned).toHaveLength(0);
    await tool(pepper)("spawn_status");
    expect(spawned.map((s) => s.path)).toEqual(["/fleet/status"]);
    await api(phone, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: true }) });
    expect(spawned.at(-1)).toMatchObject({ path: "/spawns", body: { board: "proj", task: "look at the flaky test", interactive: true, node: true } });
  });

  it("lets the user's own clients write at once", async () => {
    await tool(phone)("session_say", { bridge: "laptop-8080", key: "3-12", text: "go on" });
    expect(said.at(-1)).toMatchObject({ text: "go on" });
    expect(await names(phone)).not.toContain("confirm_status");
  });

  it("forgets what the user didn't answer in ten minutes", async () => {
    const out = JSON.parse((await tool(pepper)("spawn_stop", { id: "sp1" })).text);
    now += 11 * 60_000;
    expect(JSON.parse((await tool(pepper)("confirm_status", { id: out.confirm })).text).state).toBe("expired");
    expect((await api(phone, `confirms/${out.confirm}`, { method: "POST", body: JSON.stringify({ ok: true }) })).status).toBe(400);
  });

  it("gives a brain's token that isn't a resident's none of it", async () => {
    const brain = n.oauth.mint("an agent for assistant", 1, "assistant", "assistant");
    const tools = await names(brain);
    for (const t of ["sessions_list", "session_say", "spawn_agent", "confirm_status"]) expect(tools).not.toContain(t);
    expect((await tool(brain)("sessions_list")).text).toBe("unknown tool sessions_list");
    expect(await names(pepper)).toEqual(expect.arrayContaining(["sessions_list", "session_screen", "session_say", "session_answer", "spawn_agent", "start_session", "confirm_status"]));
  });

  it("mints a resident's token only when asked for one", async () => {
    const res = await n.call("/api/node/grants", { method: "POST", headers: { Authorization: `Bearer ${phone}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "brain", brain: "assistant", agent: "pepper", resident: true }) });
    const { token } = (await res.json()) as { token: string };
    expect(n.oauth.verify(token, ORIGIN)).toMatchObject({ brain: "assistant", resident: true });
  });
});
