// The board's MCP server as an agent drives it: `bun mcp/board.ts` over
// stdio, two of them (ann and bob) on one board, each tool called as an
// agent would and the card files read back to see what it wrote.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOARD = mkdtempSync(join(tmpdir(), "corkboard-board-"));
// A card changed as corkboard itself would (a queue, a budget hold), in a
// process of its own: cards.ts reads its board once, when it loads.
const edit = async (id: string, fn: string) => {
  const p = Bun.spawn(["bun", "-e", `const c = await import(${JSON.stringify(join(import.meta.dir, "cards.ts"))}); c.change(${JSON.stringify(id)}, ${fn});`], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CORKBOARD_BOARD: BOARD },
    stderr: "inherit",
  });
  expect(await p.exited).toBe(0);
};
const fileOf = (id: string) => join(BOARD, "tasks", readdirSync(join(BOARD, "tasks")).find((n) => n.startsWith(`${id.toLowerCase()} - `))!);

// One agent's server, and its answers by id.
function server(agent: string) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "board.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CORKBOARD_BOARD: BOARD, CORKBOARD_AGENT: agent },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const waiting = new Map<unknown, (m: any) => void>();
  const unasked: any[] = [];
  void (async () => {
    let rest = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      rest += chunk;
      for (let i; (i = rest.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(rest.slice(0, i));
        rest = rest.slice(i + 1);
        const w = waiting.get(m.id);
        if (w) waiting.delete(m.id), w(m);
        else unasked.push(m);
      }
    }
  })();
  let next = 0;
  const send = (line: string) => (proc.stdin.write(line + "\n"), proc.stdin.flush());
  const rpc = (method: string, params?: unknown): Promise<any> => {
    const id = ++next;
    const p = new Promise((r) => waiting.set(id, r));
    send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return p;
  };
  // A tool's answer: its JSON, or its error's text thrown.
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const m = await rpc("tools/call", { name, arguments: args });
    if (m.error) throw new Error(`rpc: ${m.error.message}`);
    const text = m.result.content[0].text as string;
    if (m.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { proc, rpc, call, send, unasked, stop: () => proc.kill() };
}

let ann: ReturnType<typeof server>, bob: ReturnType<typeof server>;
beforeAll(() => {
  ann = server("ann");
  bob = server("bob");
});
afterAll(async () => {
  ann.stop();
  bob.stop();
  await Promise.all([ann.proc.exited, bob.proc.exited]);
  rmSync(BOARD, { recursive: true, force: true });
});

describe("the protocol", () => {
  it("says who it is, its tools and its instructions", async () => {
    const init = await ann.rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("corkboard");
    expect(init.result.instructions).toContain('You are "ann".');
    expect((await ann.rpc("ping")).result).toEqual({});
    const { tools } = (await ann.rpc("tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["block", "claim_card", "create_card", "handoff", "list_cards", "log", "next_card", "read_card", "release_card", "request_user_action", "submit_for_review", "update_card", "write_description"],
    );
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("refuses what isn't a tool or a method, and a line that isn't JSON", async () => {
    for (const name of ["nope", "constructor", "toString", "__proto__"])
      expect((await ann.rpc("tools/call", { name })).error).toEqual({ code: -32602, message: `unknown tool ${name}` });
    expect((await ann.rpc("resources/list")).error.code).toBe(-32601);
    // A notification is answered with nothing; a bad line with a parse error.
    ann.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    ann.send("{not json");
    expect((await ann.rpc("ping")).result).toEqual({});
    expect(ann.unasked).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }]);
  });
});

describe("the tools", () => {
  let id: string;

  it("create a card, in backlog unless told, its fields cleaned", async () => {
    const c = await ann.call("create_card", { title: "Ship\nit", description: "Why and what.", labels: [" ui ", "", "x"], dependencies: [], priority: "high" });
    id = c.id;
    expect(c).toMatchObject({ title: "Ship it", status: "backlog", agent: "", priority: "high", labels: ["ui", "x"], waiting_on: [] });
    const r = await bob.call("read_card", { id });
    expect(r).toMatchObject({ id, title: "Ship it", description: "Why and what.", log: "" });
    await expect(ann.call("create_card", { title: "X", priority: "urgent" })).rejects.toThrow("priority must be one of");
    await expect(ann.call("create_card", { title: "X", status: "nonsense" })).rejects.toThrow("status must be one of");
  });

  it("create a follow-up linked both ways, and nothing for a parent that isn't there", async () => {
    const before = (await ann.call("list_cards")).length;
    await expect(ann.call("create_card", { title: "Orphan", parent: "TASK-404" })).rejects.toThrow("no card TASK-404");
    expect((await ann.call("list_cards")).length).toBe(before);
    const f = await ann.call("create_card", { title: "Follow-up", parent: id, status: "ready" });
    expect((await ann.call("read_card", { id })).log).toContain(`ann: follow-up: ${f.id}`);
    expect((await ann.call("read_card", { id: f.id })).log).toContain(`ann: created from ${id}`);
  });

  it("claim a card, and refuse it to anyone else while it's held", async () => {
    await ann.call("update_card", { id, status: "ready" });
    const c = await ann.call("claim_card", { id });
    expect(c).toMatchObject({ status: "doing", agent: "ann", agent_state: "working" });
    expect(c.log).toContain("ann: claimed");
    // Claimed again, it's as it was: no second entry.
    expect((await ann.call("claim_card", { id })).log.match(/claimed/g)).toHaveLength(1);
    await expect(bob.call("claim_card", { id })).rejects.toThrow(`card ${id} is held by ann`);
    expect(readFileSync(fileOf(id), "utf8")).toContain("assignee:\n  - ann\n");
  });

  it("let only the holder change its state, submit it or let it go", async () => {
    const theirs = `card ${id} is held by ann, not bob; claim it first`;
    await expect(bob.call("update_card", { id, agent_state: "blocked" })).rejects.toThrow(theirs);
    await expect(bob.call("submit_for_review", { id, summary: "s", verification: "v" })).rejects.toThrow(theirs);
    await expect(bob.call("release_card", { id, note: "mine now" })).rejects.toThrow(theirs);
    await expect(bob.call("block", { id, question: "?" })).rejects.toThrow(theirs);
    await expect(bob.call("request_user_action", { id, message: "do it" })).rejects.toThrow(theirs);
    // Anyone may log, retitle, relabel or reprioritise.
    await bob.call("log", { id, note: "a reviewer's note" });
    const u = await bob.call("update_card", { id, title: "Ship it now", labels: ["a"], dependencies: [" task-99 "], priority: "", ordinal: 3 });
    expect(u).toMatchObject({ title: "Ship it now", labels: ["a"], dependencies: ["task-99"], priority: "", ordinal: "3", waiting_on: ["TASK-99 (no such card)"] });
    expect((await ann.call("read_card", { id })).agent).toBe("ann");
    await expect(bob.call("update_card", { id, agent_state: "sleeping" })).rejects.toThrow("agent_state must be one of");
    await expect(bob.call("update_card", { id, status: "gone" })).rejects.toThrow("status must be one of");
    await bob.call("update_card", { id, dependencies: [] });
  });

  it("ask the user, blocked or carrying on, the first line as the attention", async () => {
    const b = await ann.call("block", { id, question: "Which way?\nA or B." });
    expect(b).toMatchObject({ agent_state: "blocked", attention: "Which way?" });
    await expect(ann.call("block", { id, question: "  " })).rejects.toThrow("say what you need");
    const r = await ann.call("request_user_action", { id, message: "x".repeat(300), wait: false });
    expect(r.agent_state).toBe("blocked");
    expect(r.attention).toBe("x".repeat(199) + "…");
    const log = (await ann.call("read_card", { id })).log;
    expect(log).toContain("ann: blocked: Which way?\n  A or B.");
    expect(log).toContain("ann: needs you: xxx");
    // The agent's next state change clears what it asked.
    expect(await ann.call("update_card", { id, agent_state: "working" })).toMatchObject({ agent_state: "working", attention: "" });
  });

  it("replace the description and keep the log", async () => {
    const before = (await ann.call("read_card", { id })).log;
    await bob.call("write_description", { id, description: "New plan.\n\n中文 too." });
    const r = await ann.call("read_card", { id });
    expect(r.description).toBe("New plan.\n\n中文 too.");
    expect(r.log).toBe(before);
  });

  it("hand off into the card's log, or with no card, nowhere", async () => {
    const h = await ann.call("handoff", { id, text: "Done: A.\nLeft: B." });
    expect(h).toContain("End your turn now");
    expect((await ann.call("read_card", { id })).log).toContain("ann: handoff:\n  Done: A.\n  Left: B.");
    expect(await ann.call("handoff", { text: "no card" })).toContain("Handed off.");
    await expect(ann.call("handoff", { id: "TASK-404", text: "x" })).rejects.toThrow("no card TASK-404");
  });

  it("submit for review with the PR's number", async () => {
    const s = await ann.call("submit_for_review", { id, summary: "Shipped.", verification: "Ran it.", pr: 12 });
    expect(s).toMatchObject({ status: "review", agent_state: "needs-review", attention: "" });
    expect((await ann.call("read_card", { id })).pr).toBe("12");
    expect((await ann.call("read_card", { id })).log).toContain("ann: Shipped.\n  Verified: Ran it.");
  });

  it("let a card go back to ready, unassigned", async () => {
    const c = await ann.call("create_card", { title: "Later", status: "ready" });
    await ann.call("claim_card", { id: c.id });
    const r = await ann.call("release_card", { id: c.id, note: "tomorrow" });
    expect(r).toMatchObject({ status: "ready", agent: "", agent_state: "" });
    expect((await bob.call("claim_card", { id: c.id })).agent).toBe("bob");
    await bob.call("release_card", { id: c.id, note: "not today either" });
  });

  it("list cards, filtered, and say what each waits on", async () => {
    const all = await ann.call("list_cards");
    expect(all.length).toBe(readdirSync(join(BOARD, "tasks")).filter((n) => n.endsWith(".md")).length);
    expect(all.every((c: { description?: string }) => c.description === undefined)).toBe(true);
    expect((await ann.call("list_cards", { status: "review" })).map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await ann.call("list_cards", { mine: true })).map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await bob.call("list_cards", { mine: true }))).toEqual([]);
    expect((await bob.call("list_cards", { agent: "ann", agent_state: "needs-review" })).map((c: { id: string }) => c.id)).toEqual([id]);
  });

  it("claim the next card: one queued for you, else the top ready one not waiting, else none", async () => {
    // Everything ready is let go of first, so only what's made here is.
    for (const c of await ann.call("list_cards", { status: "ready" })) await ann.call("update_card", { id: c.id, status: "backlog" });
    const first = await ann.call("create_card", { title: "First", status: "ready" });
    const blocked = await ann.call("create_card", { title: "Waits", status: "ready", dependencies: [first.id], priority: "high" });
    const queued = await ann.call("create_card", { title: "Queued for bob", status: "ready" });
    await edit(queued.id, `(c) => ((c.agent = "bob"), (c.agent_state = "queued"))`);
    // Queued, it's bob's to claim, not his to work on yet.
    await expect(bob.call("log", { id: queued.id, note: "x" })).resolves.toBeDefined();
    await expect(bob.call("update_card", { id: queued.id, agent_state: "working" })).rejects.toThrow("queued for you; claim it first");
    expect((await bob.call("next_card")).id).toBe(queued.id);
    // The high one waits on first, so ann gets first; then nothing's left but it.
    expect((await ann.call("next_card")).id).toBe(first.id);
    expect(await bob.call("next_card")).toBeNull();
    await expect(bob.call("claim_card", { id: blocked.id })).rejects.toThrow(`waits on ${first.id}; pass force`);
    expect((await bob.call("claim_card", { id: blocked.id, force: true })).agent).toBe("bob");
    await ann.call("update_card", { id: first.id, status: "done" });
    await expect(ann.call("claim_card", { id: first.id })).rejects.toThrow("is done");
  });

  it("refuse work on a card the budget stopped, but let the agent read, ask or let go", async () => {
    const c = await ann.call("create_card", { title: "Costly", status: "ready" });
    await ann.call("claim_card", { id: c.id });
    await edit(c.id, `(x) => void (x.budget_hold = "\$5 spent")`);
    const stop = `budget reached on ${c.id}: $5 spent`;
    await expect(ann.call("log", { id: c.id, note: "more" })).rejects.toThrow(stop);
    await expect(ann.call("submit_for_review", { id: c.id, summary: "s", verification: "v" })).rejects.toThrow(stop);
    expect((await ann.call("read_card", { id: c.id })).budget_hold).toBe("$5 spent");
    expect((await ann.call("block", { id: c.id, question: "More budget?" })).agent_state).toBe("blocked");
    expect((await ann.call("release_card", { id: c.id, note: "over budget" })).status).toBe("ready");
    // And next_card passes it by.
    for (const x of await ann.call("list_cards", { status: "ready" })) if (x.id !== c.id) await ann.call("update_card", { id: x.id, status: "backlog" });
    expect(await ann.call("next_card")).toBeNull();
  });

  it("answer a card id that isn't one as an error, not a crash", async () => {
    await expect(ann.call("read_card", { id: "../../etc/passwd" })).rejects.toThrow("bad card id");
    await expect(ann.call("log", { id: "constructor", note: "x" })).rejects.toThrow("bad card id");
    expect((await ann.rpc("ping")).result).toEqual({});
  });
});
