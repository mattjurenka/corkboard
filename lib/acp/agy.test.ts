// agy()'s Spec (lib/acp/agy.ts says what was verified): corkboard's servers
// as ACP's, the prompt in session/new's _meta, a key's sign-in, and tool
// names in Claude Code's; then AcpSession handing the _meta and the sign-in
// to a stand-in agent.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agy, key } from "./agy";
import { AcpSession } from "./client";

const dir = mkdtempSync(join(tmpdir(), "acp-agy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const gemini = { provider: "openai" as const, model: "gemini-3.8-flash", base: "https://generativelanguage.googleapis.com/v1beta/openai" };

describe("agy", () => {
  test("corkboard's servers in session/new, the prompt appended, and their tools' names", () => {
    const s = agy({
      prompt: "You are running inside corkboard.",
      mcp: [JSON.stringify({ mcpServers: { corkboard: { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } }, "corkboard-memory": { command: "bun", args: ["m.ts"], env: { A: "1" } } } })],
      servers: [{ name: "corkboard-ui", command: "nvim", args: ["-l", "ui.lua"], env: [{ name: "CORKBOARD_BUF", value: "3" }] }],
    });
    expect(s.command).toEqual(["agy", "acp"]);
    expect(s.mcpServers).toEqual([
      { type: "http", name: "corkboard", url: "http://x/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      { name: "corkboard-memory", command: "bun", args: ["m.ts"], env: [{ name: "A", value: "1" }] },
      { name: "corkboard-ui", command: "nvim", args: ["-l", "ui.lua"], env: [{ name: "CORKBOARD_BUF", value: "3" }] },
    ]);
    expect(s.meta).toEqual({ antigravity: { systemPrompt: { append: "You are running inside corkboard." } } });
    expect(s.names!("mcp_corkboard-memory_memory_recall")).toBe("mcp__corkboard-memory__memory_recall");
    expect(s.names!("mcp_corkboard_claim_card")).toBe("mcp__corkboard__claim_card");
    expect(s.names!("mcp_corkboard-ui_say")).toBe("mcp__corkboard-ui__say");
    expect(s.names!("mcp_corkboard-ui_ask")).toBe("AskUserQuestion");
    expect(s.names!("run_command")).toBe("run_command");
  });

  test("the user's own login, with no key; none of their environment's", () => {
    const s = agy({});
    expect(s.meta).toBeUndefined();
    expect(s.env).toEqual({});
    expect(s.auth!(s.env!)).toBeUndefined();
  });

  test("a Gemini brain's key, or a slot's credential, signs it in", () => {
    const s = agy({ model: gemini, key: "AIza-k" });
    expect(s.env).toEqual({ GEMINI_API_KEY: "AIza-k" });
    expect(s.auth!(s.env!)).toBe("gemini-api-key");
    expect(agy({}).auth!({ GEMINI_API_KEY: "AIza-slot" })).toBe("gemini-api-key");
  });
});

describe("key", () => {
  test("only Gemini's own", () => {
    expect(key(undefined, "k")).toBeUndefined();
    expect(key({ provider: "claude", model: "claude-opus-5-5" }, "sk-ant-api-x")).toBeUndefined();
    expect(key({ provider: "openai", model: "x/y", base: "https://openrouter.ai/api/v1" }, "k")).toBeUndefined();
    expect(key(gemini, "AIza-k")).toBe("AIza-k");
  });
});

// A stand-in that writes down what it's sent.
const AGENT = join(dir, "agent.ts");
const SEEN = join(dir, "seen.jsonl");
writeFileSync(
  AGENT,
  `
import { appendFileSync } from "node:fs";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let buf = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    appendFileSync(${JSON.stringify(SEEN)}, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
    if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "authenticate") out({ id: m.id, result: {} });
    else if (m.method === "session/new") out({ id: m.id, result: { sessionId: "ses_1" } });
    else if (m.method === "session/load") out({ id: m.id, result: {} });
  }
}
`,
);

async function seen(spec: ReturnType<typeof agy>, resume?: string) {
  rmSync(SEEN, { force: true });
  const s = new AcpSession({ spec: { ...spec, command: ["bun", AGENT] }, cwd: dir, dir: join(dir, "transcripts"), event: () => {} });
  await s.start(resume);
  s.close();
  return readFileSync(SEEN, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("AcpSession with agy's spec", () => {
  test("the prompt in session/new's _meta, and no sign-in of its own", async () => {
    const got = await seen(agy({ prompt: "Be brief." }));
    expect(got.map((m) => m.method)).toEqual(["initialize", "session/new"]);
    expect(got[1].params._meta).toEqual({ antigravity: { systemPrompt: { append: "Be brief." } } });
  });

  test("a key's sign-in before the session, and the prompt in session/load's too", async () => {
    const got = await seen(agy({ prompt: "Be brief.", model: gemini, key: "AIza-k" }), "ses_1");
    expect(got.map((m) => m.method)).toEqual(["initialize", "authenticate", "session/load"]);
    expect(got[1].params).toEqual({ methodId: "gemini-api-key" });
    expect(got[2].params).toMatchObject({ sessionId: "ses_1", _meta: { antigravity: { systemPrompt: { append: "Be brief." } } } });
  });
});
