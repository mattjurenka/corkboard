// The slot's ACP runner against a stand-in agent: a task's result, a
// session's turns from the inbox and their result lines, an interrupt, the
// kind's credential in its environment.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-acp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SHARE = join(root, "share");
const OUT = join(root, "outbox");
process.env.FLEET_SHARE = SHARE;
process.env.FLEET_OUTBOX = OUT;
process.env.HOME = root;

const { main, message, credential, credentialEnv, allow } = await import("./acp");
const { KINDS } = await import("../../lib/acp/kinds");

// Says what it was asked and its KEY, asks a permission first; "slow" waits
// for a cancel.
const AGENT = join(root, "agent.ts");
writeFileSync(
  AGENT,
  `
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const up = (sessionId, update) => out({ method: "session/update", params: { sessionId, update } });
let buf = "", turn = null, text = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === "session/new") out({ id: m.id, result: { sessionId: "ses_1" } });
    else if (m.method === "session/cancel") out({ id: turn, result: { stopReason: "cancelled" } });
    else if (m.method === "session/prompt") {
      turn = m.id;
      text = m.params.prompt[0].text;
      if (text === "slow") continue;
      out({ id: 900, method: "session/request_permission", params: { sessionId: "ses_1", toolCall: { toolCallId: "t1", title: "x" }, options: [{ optionId: "no", kind: "reject_once", name: "No" }, { optionId: "yes", kind: "allow_once", name: "Yes" }] } });
    } else if (m.id === 900) {
      up("ses_1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "x", status: "completed" });
      up("ses_1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "got " + text + " " + m.result.outcome.optionId + " " + process.env.KEY } });
      out({ id: turn, result: { stopReason: "end_turn" } });
    }
  }
}
`,
);
KINDS.fake = () => ({ command: ["bun", AGENT] });

beforeEach(() => {
  rmSync(SHARE, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SHARE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(SHARE, "fake-credential"), "# the account's\nKEY=k1\n");
});

const result = () => JSON.parse(readFileSync(join(OUT, "result.json"), "utf8"));
let sent = 0;
const post = (line: string) => {
  mkdirSync(join(SHARE, "inbox"), { recursive: true });
  writeFileSync(join(SHARE, "inbox", String(sent++)), line);
};
const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

describe("fleet acp", () => {
  test("lines", () => {
    expect(message(user("hi"))).toEqual({ prompt: "hi" });
    expect(message('{"type":"control_request","request_id":"e","request":{"subtype":"interrupt"}}')).toEqual({ interrupt: true });
    expect(message("END\n")).toEqual({ end: true });
    expect(message("junk")).toBeNull();
    expect(credential("A=1\n# no\n\nB = 2\nC=x=y")).toEqual({ A: "1", C: "x=y" });
    expect(JSON.parse(credentialEnv("codex", "OPENAI_API_KEY=sk-1").DEFAULT_AUTH_REQUEST)._meta.gateway.headers).toEqual({ Authorization: "Bearer sk-1" });
    expect(credentialEnv("agy", "GEMINI_API_KEY=g")).toEqual({ GEMINI_API_KEY: "g" });
    expect(allow({ tool: { id: "", name: "", title: "" }, options: [{ optionId: "a", kind: "allow_once", name: "" }, { optionId: "b", kind: "allow_always", name: "" }] })).toBe("b");
  });

  test("a task", async () => {
    writeFileSync(join(SHARE, "task.md"), "the task");
    expect(await main(["fake", "task"])).toBe(0);
    expect(result()).toEqual({ result: "got the task yes k1", stop_reason: "end_turn", is_error: false });
    expect(readdirSync(join(OUT, "projects", "acp"))).toEqual(["ses_1.jsonl"]);
  });

  test("a session", async () => {
    sent = 0;
    post(user("one"));
    post(user("slow"));
    const done = main(["fake", "session"]);
    const lines = () => (existsSync(join(OUT, "events.jsonl")) ? readFileSync(join(OUT, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    while (lines().length < 2) await Bun.sleep(50);
    post('{"type":"control_request","request_id":"e","request":{"subtype":"interrupt"}}\n');
    post(user("two"));
    post("END\n");
    expect(await done).toBe(0);
    const r = lines().filter((l) => l.type === "result");
    expect(lines()[0]).toMatchObject({ type: "system", subtype: "init", session_id: "ses_1" });
    expect(r.map((l) => [l.result, l.stop_reason])).toEqual([
      ["got one yes k1", "end_turn"],
      ["", "cancelled"],
      ["got two yes k1", "end_turn"],
    ]);
    expect(result().result).toBe("got two yes k1");
  }, 20000);
});
