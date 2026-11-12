// AcpSession against a stand-in agent that speaks ACP as opencode does
// (lib/acp/opencode.ts says what was verified): a turn's words, a tool call
// whose input comes after it, a permission asked and answered, an ask,
// usage; then the transcript as bridge/transcript.ts reads it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession, type Event, type Permission } from "./client";
import { opencode } from "./opencode";
import { items } from "../../bridge/transcript";

const dir = mkdtempSync(join(tmpdir(), "acp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT = join(dir, "agent.ts");
writeFileSync(
  AGENT,
  `
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const up = (sessionId, update) => out({ method: "session/update", params: { sessionId, update } });
let buf = "", turn = null;
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "session/new") out({ id: m.id, result: { sessionId: "ses_1" } });
    else if (m.method === "session/load") { up(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } }); out({ id: m.id, result: {} }); }
    else if (m.method === "session/prompt") {
      const s = m.params.sessionId;
      turn = m.id;
      up(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me " } });
      up(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "look." } });
      up(s, { sessionUpdate: "tool_call", toolCallId: "t1", name: "write", title: "write", kind: "edit", status: "pending", rawInput: { cwd: "/w" } });
      up(s, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: { path: "b.txt", content: "x" } });
      out({ id: 900, method: "session/request_permission", params: { sessionId: s, toolCall: { toolCallId: "t1", name: "write", title: "b.txt" }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
    } else if (m.id === 900) {
      const s = "ses_1";
      const ok = m.result.outcome.optionId === "once";
      up(s, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: ok ? "Created b.txt" : "declined" } }], rawOutput: { metadata: { exit: 0 } } });
      up(s, { sessionUpdate: "tool_call", toolCallId: "t3", name: "bash", title: "ls", kind: "execute", status: "pending", rawInput: { cwd: "/w" } });
      up(s, { sessionUpdate: "tool_call_update", toolCallId: "t3", status: "in_progress", rawInput: { command: "ls nope", cwd: "/w" } });
      up(s, { sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed", content: [{ type: "content", content: { type: "text", text: "no such file\\n\\nExited with code 2" } }], rawOutput: { metadata: { status: "completed", exit: 2 } } });
      up(s, { sessionUpdate: "tool_call", toolCallId: "t2", name: "corkboard-ui_ask", title: "corkboard-ui_ask", status: "pending", rawInput: { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }] } });
      up(s, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "content", content: { type: "text", text: "Which? → A" } }] });
      up(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
      up(s, { sessionUpdate: "usage_update", used: 9000, size: 100000, cost: { amount: 0.02, currency: "USD" } });
      out({ id: turn, result: { stopReason: ok ? "end_turn" : "cancelled", usage: { inputTokens: 10, outputTokens: 2 } } });
    }
  }
}
`,
);

const spec = () => ({ ...opencode({ dir, name: "test", servers: [{ name: "corkboard-ui", command: "x", args: [], env: [] }] }), command: ["bun", AGENT] });

function run(answer: string | null) {
  const events: Event[] = [];
  const asked: Permission[] = [];
  const s = new AcpSession({
    spec: spec(),
    cwd: dir,
    dir: join(dir, "transcripts"),
    event: (e) => events.push(e),
    permission: async (p) => (asked.push(p), answer),
  });
  return { s, events, asked };
}

describe("AcpSession", () => {
  test("a turn: events, the permission and the transcript", async () => {
    const { s, events, asked } = run("once");
    expect(await s.start()).toBe("ses_1");
    expect(await s.prompt("make b.txt")).toBe("end_turn");
    s.close();
    expect(events.map((e) => e.event)).toEqual(["start", "turn", "tool", "permission", "tool_done", "tool", "tool_done", "settled"]);
    expect(events[2].tool_name).toBe("write");
    expect(asked[0].tool).toMatchObject({ id: "t1", name: "write", title: "b.txt" });
    expect(s.usage).toEqual({ used: 9000, size: 100000, cost: { amount: 0.02, currency: "USD" } });

    const path = events[0].transcript!;
    expect(path).toBe(join(dir, "transcripts", "ses_1.jsonl"));
    const records = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const got = records.flatMap(items).map(({ id, at, ...i }) => i);
    expect(got).toEqual([
      { kind: "you", text: "make b.txt" },
      { kind: "claude", text: "Let me look." },
      { kind: "tool", tool: "write", call: "t1", detail: "b.txt" },
      { kind: "result", call: "t1", text: "Created b.txt", error: false },
      // Its input once it's past pending; a command that exited 2 failed.
      { kind: "tool", tool: "bash", call: "t3", detail: "ls nope" },
      { kind: "result", call: "t3", text: "no such file\n\nExited with code 2", error: true },
      {
        kind: "tool",
        tool: "AskUserQuestion",
        call: "t2",
        detail: "Which?",
        options: [["A"]],
        questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }],
      },
      { kind: "result", call: "t2", text: "Which? → A", error: false },
      { kind: "claude", text: "Done." },
    ]);
    expect(records.filter((r) => r.type === "usage")).toMatchObject([{ used: 9000, size: 100000 }, { tokens: { inputTokens: 10 } }]);
  });

  test("refused: the tool fails and the turn is cancelled", async () => {
    const { s } = run(null);
    await s.start();
    expect(await s.prompt("make b.txt")).toBe("cancelled");
    s.close();
  });

  test("resumed: what it replays isn't written again", async () => {
    const { s, events } = run("once");
    expect(await s.start("ses_1")).toBe("ses_1");
    s.close();
    expect(events.map((e) => e.event)).toEqual(["start"]);
  });

  test("the prompt's file goes when the agent ends", async () => {
    const ended = Promise.withResolvers<void>();
    const s = new AcpSession({
      spec: { ...opencode({ dir, name: "prompted", prompt: "Be brief." }), command: ["bun", AGENT] },
      cwd: dir,
      dir: join(dir, "transcripts"),
      event: () => {},
      exit: () => ended.resolve(),
    });
    await s.start();
    expect(existsSync(join(dir, "prompted.md"))).toBe(true);
    s.close();
    await ended.promise;
    expect(existsSync(join(dir, "prompted.md"))).toBe(false);
  });
});

describe("opencode", () => {
  test("corkboard's servers in its config, codemode off, and their tools' names", () => {
    const s = opencode({
      dir,
      name: "cfg",
      prompt: "Be brief.",
      mcp: [JSON.stringify({ mcpServers: { corkboard: { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } }, "corkboard-memory": { command: "bun", args: ["m.ts"] } } })],
      servers: [{ name: "corkboard-ui", command: "nvim", args: ["-l", "ui.lua"], env: [{ name: "CORKBOARD_BUF", value: "3" }] }],
      model: { provider: "openai", model: "z-ai/glm-5", base: "https://openrouter.ai/api/v1" },
      key: "sk-or-1",
    });
    const config = JSON.parse(s.env!.OPENCODE_CONFIG_CONTENT);
    expect(config.mcp).toEqual({
      corkboard: { type: "remote", url: "http://x/mcp", headers: { Authorization: "Bearer t" }, codemode: false },
      "corkboard-memory": { type: "local", command: ["bun", "m.ts"], environment: {}, codemode: false },
      "corkboard-ui": { type: "local", command: ["nvim", "-l", "ui.lua"], environment: { CORKBOARD_BUF: "3" }, codemode: false },
    });
    expect(readFileSync(config.instructions[0], "utf8")).toBe("Be brief.");
    expect(config.model).toBe("openrouter/z-ai/glm-5");
    expect(s.env!.OPENROUTER_API_KEY).toBe("sk-or-1");
    expect(s.mcpServers).toEqual([]);
    expect(s.names!("corkboard-memory_memory_recall")).toBe("mcp__corkboard-memory__memory_recall");
    expect(s.names!("corkboard_claim_card")).toBe("mcp__corkboard__claim_card");
    expect(s.names!("corkboard-ui_say")).toBe("mcp__corkboard-ui__say");
    expect(s.names!("corkboard-ui_ask")).toBe("AskUserQuestion");
    expect(s.names!("bash")).toBe("bash");
  });
});
