// The session tools on /mcp (talk.ts): the account's sessions listed, read,
// sent a message and answered, on this machine's hub and on another's over
// a sealed channel, as serve.ts's reach reaches them.   bun test bridge/node/talk.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { type Identity, initiate, pipe, respond } from "../../lib/e2ee/channel";
import { certify, checkCert, newDevice } from "../../lib/e2ee/device";
import { fuzz } from "../../lib/testing/fuzz";
import { Hub, joinHub } from "../hub";
import { type Answers, type Hosted, answers, inWords, serve } from "../sessions";
import { type Item, type Question, asked } from "../transcript";
import type { Reach } from "../peers";
import type { Caller } from "./mcp";
import { node } from "./server";
import { TALK_TOOLS } from "./talk";
import { NO_WORKER, ORIGIN, rpc, setup, toolText } from "./testing";

const record = (type: string, content: unknown, uuid = crypto.randomUUID()) => JSON.stringify({ type, uuid, timestamp: "2026-11-22T10:00:00Z", message: { role: type, content } }) + "\n";
const QUESTIONS = [
  { header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
  { header: "Sizes", question: "Which sizes?", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }, { label: "L", description: "" }] },
];

async function setupTalk() {
  const n = await setup();
  // This machine's hub, and another machine's on a sealed channel.
  const here = new Hub();
  const there = new Hub();
  const log = join(n.dir, "session.jsonl");
  writeFileSync(
    log,
    record("user", "pick colours for the site") +
      record("assistant", [{ type: "text", text: "Looking at the palette." }]) +
      record("assistant", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls", description: "List files" } }]) +
      record("user", [{ type: "tool_result", tool_use_id: "b1", content: "site.css" }]) +
      record("assistant", [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: QUESTIONS } }]),
  );
  const vmLog = join(n.dir, "vm.jsonl");
  writeFileSync(
    vmLog,
    record("user", "which db?") +
      record("assistant", [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: { questions: [QUESTIONS[0]] } }]) +
      record("user", [{ type: "tool_result", tool_use_id: "q2", is_error: true, content: "no one to ask" }]) +
      record("assistant", [{ type: "text", text: "Which colour, Red or Blue?" }]),
  );
  const local: Hosted[] = [
    { key: "1-2", name: "Colours", state: "asking", project: "site", since: Date.parse("2026-11-22T10:00:00Z"), transcript: log },
    { key: "3-4", name: "Deploy", state: "permission", detail: "Bash: rm -rf dist", transcript: log },
    { key: "screen-1", name: "A shell", state: "idle" },
  ];
  const saidHere: unknown[] = [];
  serve("laptop-1", "laptop", {
    list: () => local,
    watch: () => {},
    say: async (key, text, keys, a) => (saidHere.push(a ? [key, a] : [key, text, keys]), { ok: true }),
    screen: async (key) =>
      key === "screen-1"
        ? { lines: ["$ make"], width: 80 }
        : key === "3-4"
          ? { lines: ["│ Bash command", "│   rm -rf dist", "│ Do you want to proceed?", "│ ❯ 1. Yes", "│   2. Yes, and don't ask again for rm commands in /site", "│   3. No, and tell Claude what to do differently (esc)"], width: 80 }
          : { error: "no such", missing: true },
    hub: joinHub(here),
  }, NO_WORKER);
  const saidThere: unknown[] = [];
  serve("fleetd-vm", "vm", {
    list: () => [{ key: "s1", name: "VM work", state: "idle", vm: "agent-0", transcript: vmLog }],
    watch: () => {},
    say: async (key, text, keys, a) => (saidThere.push(a ? [key, a] : [key, text, keys]), { ok: true }),
    hub: joinHub(there),
  }, NO_WORKER);
  const keys = accountKeys(newRoot());
  const id = (name: string): Identity => {
    const d = newDevice();
    return { device: d, cert: certify(keys, d, name, Date.now()), trust: (c) => checkCert(keys.id, c, []) };
  };
  const me = id("node");
  const far = id("vm-host");
  let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
  a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
  b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
  const [ch] = await Promise.all([initiate(a.link, me, far.device.id), respond(b.link, far, { serve: async (req) => (await there.serve(req)) ?? Response.json({ error: "not found" }, { status: 404 }) })]);
  const reach: Reach = {
    devices: async () => ({ me: "laptop", devices: ["laptop", "vm-host", "gone"] }),
    fetch: async (device, path, init = {}) => {
      if (device === "laptop") return (await here.serve(new Request(`http://node.invalid${path}`, init))) ?? Response.json({ error: "not found" }, { status: 404 });
      if (device === "vm-host") return ch.fetch(path, init);
      throw new Error("no channel to it");
    },
  };
  const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, reach });
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) =>
    toolText(await app(new Request(`${ORIGIN}/mcp`, rpc("tools/call", { name, arguments: args }, token))));
  const names = async (token: string) => ((await (await app(new Request(`${ORIGIN}/mcp`, rpc("tools/list", {}, token)))).json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  return { n, app, call, names, saidHere, saidThere, close: () => (ch.close(), n.stop()) };
}

describe("the account's sessions over the node's MCP", () => {
  let t: Awaited<ReturnType<typeof setupTalk>>;
  let token: string;
  beforeAll(async () => {
    t = await setupTalk();
    // claude.ai's connector: an assistant's grant.
    token = t.n.oauth.mint("claude.ai", 1, "assistant");
  });
  afterAll(() => t.close());

  it("lists every connected machine's sessions, and the machines that didn't answer", async () => {
    const got = await t.call(token, "list_sessions");
    expect(got.error).toBe(false);
    const { sessions, unreachable } = JSON.parse(got.text);
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual(["laptop/laptop-1/1-2", "laptop/laptop-1/3-4", "laptop/laptop-1/screen-1", "vm-host/fleetd-vm/s1"]);
    expect(sessions.find((s: { id: string }) => s.id === "laptop/laptop-1/1-2")).toEqual({ id: "laptop/laptop-1/1-2", machine: expect.any(String), name: "Colours", state: "asking", since: "2026-11-22T10:00:00.000Z", project: "site" });
    expect(unreachable).toEqual(["gone"]);
  });

  it("reads a session's last turns, a tool's result under its call, and the question it waits on", async () => {
    const got = JSON.parse((await t.call(token, "read_session", { session: "laptop/laptop-1/1-2" })).text);
    expect(got).toMatchObject({ name: "Colours", state: "asking" });
    expect(got.turns).toEqual([
      { at: "2026-11-22T10:00:00Z", you: "pick colours for the site" },
      { at: "2026-11-22T10:00:00Z", claude: "Looking at the palette." },
      { at: "2026-11-22T10:00:00Z", tool: "Bash", detail: "List files", result: "site.css" },
      { at: "2026-11-22T10:00:00Z", tool: "AskUserQuestion", detail: "Which colour?\nWhich sizes?" },
    ]);
    expect(got.asked).toBe("q1");
    expect(got.partial).toBeUndefined();
    expect(got.question[0]).toEqual({ header: "Colour", question: "Which colour?", multiSelect: false, options: [{ n: 0, label: "Red", description: "warm" }, { n: 1, label: "Blue", description: "cool" }] });
    expect(got.question[1].options.map((o: { n: number }) => o.n)).toEqual([0, 1, 2]);
    // The newest, as many as asked.
    expect(JSON.parse((await t.call(token, "read_session", { session: "laptop/laptop-1/1-2", turns: 1 })).text).turns).toHaveLength(1);
  });

  it("reads a VM's session over its channel, whose failed question still waits for an answer", async () => {
    const got = JSON.parse((await t.call(token, "read_session", { session: "vm-host/fleetd-vm/s1" })).text);
    expect(got.turns.at(-1)).toEqual({ at: expect.any(String), claude: "Which colour, Red or Blue?" });
    expect(got.turns[1]).toMatchObject({ tool: "AskUserQuestion", error: "no one to ask" });
    expect(got.question).toHaveLength(1);
    expect(got.asked).toBe("q2");
  });

  it("gives a session with no conversation its screen", async () => {
    const got = JSON.parse((await t.call(token, "read_session", { session: "laptop/laptop-1/screen-1" })).text);
    expect(got.turns).toEqual([]);
    expect(got.screen).toEqual({ lines: ["$ make"], width: 80 });
  });

  it("sends a message with enter, an interrupt first when asked, and answers", async () => {
    expect((await t.call(token, "send_session", { session: "laptop/laptop-1/1-2", text: "  use the brand colours  " })).error).toBe(false);
    expect((await t.call(token, "send_session", { session: "laptop/laptop-1/1-2", text: "stop that", interrupt: true })).error).toBe(false);
    expect((await t.call(token, "send_session", { session: "laptop/laptop-1/1-2", interrupt: true })).error).toBe(false);
    expect(await t.call(token, "send_session", { session: "laptop/laptop-1/1-2", text: " " })).toEqual({ error: true, text: "say something, or interrupt it" });
    expect((await t.call(token, "answer_session", { session: "laptop/laptop-1/1-2", question: "q1", answers: [{ picks: [1] }, { picks: [0, 2], other: "XL" }] })).error).toBe(false);
    expect(await t.call(token, "answer_session", { session: "laptop/laptop-1/1-2", question: "q1", answers: [{ picks: [-1] }] })).toEqual({ error: true, text: "each answer needs picks, the options' numbers from 0" });
    expect(t.saidHere).toEqual([
      ["1-2", "use the brand colours", ["enter"]],
      ["1-2", "", ["esc"]],
      ["1-2", "stop that", ["enter"]],
      ["1-2", "", ["esc"]],
      ["1-2", [{ picks: [1] }, { picks: [0, 2], other: "XL" }]],
    ]);
    // And over the channel.
    expect((await t.call(token, "answer_session", { session: "vm-host/fleetd-vm/s1", question: "q2", answers: [{ picks: [0] }] })).error).toBe(false);
    expect(t.saidThere).toEqual([["s1", [{ picks: [0] }]]]);
  });

  it("answers a question only as it's asked now, with options it has", async () => {
    const before = t.saidHere.length;
    const answer = (args: Record<string, unknown>) => t.call(token, "answer_session", { session: "laptop/laptop-1/1-2", ...args });
    expect(await answer({ answers: [{ picks: [1] }, { picks: [0] }] })).toEqual({ error: true, text: "it's asking something else now; read it again" });
    expect(await answer({ question: "q0", answers: [{ picks: [1] }, { picks: [0] }] })).toEqual({ error: true, text: "it's asking something else now; read it again" });
    expect(await answer({ question: "q1", answers: [{ picks: [2] }, { picks: [0] }] })).toEqual({ error: true, text: "question 1's options are 0 to 1" });
    expect(await answer({ question: "q1", answers: [{ picks: [0, 1] }, { picks: [0] }] })).toEqual({ error: true, text: "question 1 takes one answer" });
    expect(await answer({ question: "q1", answers: [{ picks: [0] }] })).toEqual({ error: true, text: "answers must be a list, one for each of its 2 questions" });
    expect((await answer({ question: "q1", answers: [{ picks: [0], other: "x".repeat(2001) }, { picks: [0] }] })).error).toBe(true);
    expect(t.saidHere.length).toBe(before);
  });

  it("sends a session that's only a screen nothing: no message, answer or choice", async () => {
    const before = t.saidHere.length;
    for (const [tool, args] of [["send_session", { text: "rm -rf ~" }], ["send_session", { interrupt: true }], ["answer_session", { choice: 1 }], ["answer_session", { answers: [{ picks: [0] }] }]] as const)
      expect(await t.call(token, tool, { session: "laptop/laptop-1/screen-1", ...args })).toEqual({ error: true, text: "that session is only a screen, and is sent nothing from here" });
    expect(t.saidHere.length).toBe(before);
  });

  it("answers a permission prompt with its option's number, and only one that's waiting", async () => {
    expect((await t.call(token, "answer_session", { session: "laptop/laptop-1/3-4", choice: 3 })).error).toBe(false);
    expect(t.saidHere.at(-1)).toEqual(["3-4", "3", []]);
    expect((await t.call(token, "answer_session", { session: "laptop/laptop-1/3-4", choice: 1 })).error).toBe(false);
    expect(t.saidHere.at(-1)).toEqual(["3-4", "1", []]);
    const before = t.saidHere.length;
    expect(await t.call(token, "answer_session", { session: "laptop/laptop-1/3-4", choice: 2 })).toEqual({ error: true, text: `"Yes, and don't ask again for rm commands in /site" is the user's to pick, on the session itself` });
    expect(await t.call(token, "answer_session", { session: "laptop/laptop-1/3-4", choice: 4 })).toEqual({ error: true, text: "its screen shows no such option" });
    expect(t.saidHere.length).toBe(before);
    expect(await t.call(token, "answer_session", { session: "laptop/laptop-1/1-2", choice: 1 })).toEqual({ error: true, text: "it isn't waiting on a permission prompt" });
    expect((await t.call(token, "answer_session", { session: "laptop/laptop-1/3-4", choice: 0 })).text).toBe("choice is the option's number, from 1");
  });

  it("refuses a session that isn't one, on a machine that isn't connected", async () => {
    expect((await t.call(token, "read_session", { session: "laptop/laptop-1/9-9" })).text).toMatch(/has ended, or isn't one/);
    expect((await t.call(token, "read_session", { session: "elsewhere/laptop-1/1-2" })).text).toBe("machine elsewhere isn't connected");
    expect((await t.call(token, "read_session", { session: "gone/laptop-1/1-2" })).text).toBe("no channel to it");
    for (const bad of ["laptop", "laptop/laptop-1", "laptop/laptop-1/1-2/say", "../x/y", "laptop/__proto__/constructor", 7, null])
      expect(await t.call(token, "send_session", { session: bad, text: "hi" })).toMatchObject({ error: true });
  });

  it("is the user's own clients' only: not a brain's, a card's agent's or a fleet session's", async () => {
    const tools = ["list_sessions", "read_session", "send_session", "answer_session"];
    expect(await t.names(token)).toEqual(expect.arrayContaining(tools));
    expect(await t.names(t.n.oauth.mint("phone", 1, "owner"))).toEqual(expect.arrayContaining(tools));
    const brain = t.n.oauth.mint("pepper", 1, "owner", "assistant");
    expect(await t.names(brain)).not.toContain("send_session");
    expect((await t.call(brain, "send_session", { session: "laptop/laptop-1/1-2", text: "hi" })).error).toBe(true);
    const before = t.saidHere.length;
    for (const grant of [t.n.oauth.mintBound({ scope: "card", board: "proj", card: "TASK-1", agent: "claude" }), t.n.oauth.mintBound({ scope: "session", board: "proj", spawn: "s1", agent: "fleet" })]) {
      expect(await t.names(grant.token)).not.toContain("list_sessions");
      expect((await t.call(grant.token, "send_session", { session: "laptop/laptop-1/1-2", text: "hi" })).error).toBe(true);
    }
    expect(t.saidHere.length).toBe(before);
  });

  fuzz("refuses any id that isn't a session's, without a crash", async (g) => {
    const session = g.bool(0.5) ? g.string(24) : [g.key(["laptop"]), g.key(["laptop-1"]), g.key(["1-2"])].join("/");
    const got = await t.call(token, g.pick(["read_session", "send_session", "answer_session"]), { session, text: "x", answers: g.json(2) });
    if (session === "laptop/laptop-1/1-2") return;
    expect(got.error).toBe(true);
  }, { runs: 50 });
});

describe("a conversation from a machine whose batches come apart", () => {
  // A machine that sends these lines on attach and keeps the stream open.
  const machine = (sent: string[]) => {
    let aborted = 0;
    const reach: Reach = {
      devices: async () => ({ me: "old", devices: ["old"] }),
      fetch: async (_d, path, init = {}) => {
        if (path === "/api/sessions") return Response.json([{ id: "b", machine: "old", sessions: [{ key: "k", name: "Old", state: "idle", attach: true }] }]);
        init.signal?.addEventListener("abort", () => aborted++);
        const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(sent.map((l) => l + "\n").join(""))) });
        return new Response(body);
      },
    };
    return { reach, aborted: () => aborted };
  };
  const out = (batch: object) => JSON.stringify({ type: "out", stream: "x", data: JSON.stringify(batch) });
  const said = { id: "y", at: "", kind: "you", text: "hi" };

  it("is whole once its machine says so, and partial when it only stops for a while", async () => {
    const whole = machine([out({ reset: true, items: [said] }), out({ items: [{ ...said, id: "z" }], whole: true })]);
    const got = (await TALK_TOOLS.read_session.run({ session: "old/b/k" }, whole)) as any;
    expect(got.turns).toHaveLength(2);
    expect(got.partial).toBeUndefined();
    expect(whole.aborted()).toBe(1);
    const old = machine([out({ reset: true, items: [said] })]);
    const part = (await TALK_TOOLS.read_session.run({ session: "old/b/k" }, old)) as any;
    expect(part.turns).toHaveLength(1);
    expect(part.partial).toBe(true);
  });

  it("says when what it sent isn't a conversation, and lets go of the stream", async () => {
    const bad = machine([JSON.stringify({ type: "out", stream: "x", data: "{not json" })]);
    await expect(TALK_TOOLS.read_session.run({ session: "old/b/k" }, bad)).rejects.toThrow("its machine sent a conversation that isn't one");
    expect(bad.aborted()).toBe(1);
  });
});

describe("the question a session waits on", () => {
  const ask = (call: string): Item & { kind: "tool" } => ({ id: call, at: "", kind: "tool", tool: "AskUserQuestion", call, detail: "", questions: QUESTIONS as Question[] });
  const result = (call: string, text: string, error = false): Item => ({ id: `r${call}`, at: "", kind: "result", call, text, error });
  const you: Item = { id: "y", at: "", kind: "you", text: "never mind" };
  it("is the last one asked, unless it's answered, turned down, stopped or spoken over", () => {
    expect(asked([ask("a")])?.call).toBe("a");
    expect(asked([ask("a"), result("a", "User has answered your questions")])).toBeUndefined();
    expect(asked([ask("a"), result("a", "The user doesn't want to proceed with this tool use. The tool use was rejected", true)])).toBeUndefined();
    expect(asked([ask("a"), result("a", "[Request interrupted by user for tool use]", true)])).toBeUndefined();
    expect(asked([ask("a"), result("a", "no one to ask", true)])?.call).toBe("a");
    expect(asked([ask("a"), result("a", "no one to ask", true), you])).toBeUndefined();
    expect(asked([ask("a"), result("a", "done"), ask("b")])?.call).toBe("b");
    expect(asked([ask("a"), ask("b"), result("b", "done")])).toBeUndefined();
    expect(asked([{ ...ask("a"), questions: undefined }])).toBeUndefined();
    expect(asked([])).toBeUndefined();
  });
});

describe("answers in words", () => {
  const q = QUESTIONS as Question[];
  it("says each question's header and what was picked, or why they don't answer it", () => {
    expect(inWords(q, [{ picks: [1] }, { picks: [0, 2], other: " XL " }])).toEqual({ text: "Colour: Blue\nSizes: S, L, XL" });
    expect(inWords([{ ...q[0], header: "" }], [{ picks: [], other: "Green" }])).toEqual({ text: "Which colour?: Green" });
    expect(inWords(q, [{ picks: [0] }])).toEqual({ error: "answers must be a list, one for each of its 2 questions" });
    expect(inWords(q, [{ picks: [0], other: "Green" }, { picks: [0] }])).toEqual({ error: "question 1 takes one answer" });
    expect(inWords(q, [{ picks: [] }, { picks: [0] }])).toEqual({ error: "question 1 has no answer" });
    expect(inWords(q, [{ picks: [0] }, { picks: [3] }])).toEqual({ error: "question 2's options are 0 to 2" });
  });

  fuzz("never throws on answers off the wire, nor names what isn't an option", (g) => {
    const a = answers(g.json(3, ["picks", "other"]));
    if (typeof a === "string") return;
    const said = inWords(q, a as Answers);
    if ("text" in said) for (const line of said.text.split("\n")) expect(line).toMatch(/^(Colour|Sizes): /);
  });
});
