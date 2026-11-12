// corkboard-ui's own MCP server (ui-mcp.lua), spoken to on stdio as a CLI
// would, against a real Neovim with the real corkboard.questions and stubs that
// write down what the session's state, the page and the avatar are told.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "ui-mcp.lua");
const LUA = join(import.meta.dir, "..", "lua");
const dir = mkdtempSync(join(tmpdir(), "corkboard-ui-mcp-"));
const socket = join(dir, "nvim.sock");
const events = join(dir, "events");

const STUB = String.raw`
package.path = os.getenv("LUA_DIR") .. "/?.lua;" .. package.path
local path = os.getenv("EVENTS")
io.open(path, "w"):close()
local function note(kind, v)
  local f = io.open(path, "a")
  f:write(vim.json.encode({ kind = kind, v = v }), "\n")
  f:close()
end
package.loaded["corkboard.agents"] = { hook = function(ev) note("hook", ev) end }
package.loaded["corkboard"] = { notify = function(method, n) note(method, n) end }
package.loaded["corkboard.avatar"] = { say = function(buf, item) note("said", item) end }
package.loaded["corkboard.agent"] = {
  of = function() return { name = "test", label = "Test CLI", prompt = function(buf, text) note("prompt", text) end } end,
}
vim.b[1].corkboard_agent = "test"
`;

let nvim: Subprocess;

beforeAll(async () => {
  const stub = join(dir, "stub.lua");
  writeFileSync(stub, STUB);
  nvim = Bun.spawn(["nvim", "--headless", "--clean", "--listen", socket, "-c", `luafile ${stub}`], {
    env: { ...process.env, EVENTS: events, LUA_DIR: LUA },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 500 && !(existsSync(socket) && existsSync(events)); i++) await Bun.sleep(10);
  if (!existsSync(events)) throw new Error("nvim didn't start");
});

afterAll(() => {
  nvim.kill();
  rmSync(dir, { recursive: true, force: true });
});

const noted = () =>
  readFileSync(events, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// Lua run in the session's Neovim, as the phone's answers arrive (away.lua).
function lua(code: string) {
  const p = Bun.spawnSync(["nvim", "--headless", "--clean", "--server", socket, "--remote-expr", `luaeval("${code.replace(/"/g, '\\"')}")`]);
  return p.stdout.toString().trim();
}

// The server, and one request at a time to it.
function server(wait = 2) {
  const proc = Bun.spawn(["nvim", "--clean", "--headless", "-l", SERVER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NVIM: socket, CORKBOARD_BUF: "1", CORKBOARD_ASK_WAIT: String(wait) },
  });
  const reader = proc.stdout.getReader();
  let buffered = "";
  let id = 0;
  async function call(method: string, params: unknown = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    proc.stdin.flush();
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the server ended");
      buffered += new TextDecoder().decode(value);
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return JSON.parse(line);
  }
  const tool = async (name: string, args: unknown) => (await call("tools/call", { name, arguments: args })).result;
  return { call, tool, stop: () => proc.kill() };
}

const QUESTIONS = [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }];

test("lists its tools", async () => {
  const s = server();
  const init = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  expect(init.result.serverInfo.name).toBe("corkboard-ui");
  const list = await s.call("tools/list");
  expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["ask", "notify", "show", "say", "emote"]);
  s.stop();
});

test("notify reaches the page with the kind's label", async () => {
  const s = server();
  expect((await s.tool("notify", { message: "done with the migration" })).content[0].text).toBe("sent");
  const n = noted().findLast((e) => e.kind === "corkboard.notification").v;
  expect(n).toMatchObject({ message: "done with the migration", sent: true, buf: 1, source: "test", label: "Test CLI" });
  s.stop();
});

test("say and emote reach the avatar", async () => {
  const s = server();
  await s.tool("say", { text: "All done.", mood: "happy" });
  await s.tool("emote", { emote: "wave" });
  const said = noted().filter((e) => e.kind === "said").map((e) => e.v);
  expect(said.slice(-2)).toEqual([{ text: "All done.", mood: "happy" }, { emote: "wave" }]);
  s.stop();
});

test("ask waits for the answers and returns them", async () => {
  const s = server(10);
  const asked = s.tool("ask", { questions: QUESTIONS });
  for (let i = 0; i < 100 && !noted().some((e) => e.kind === "hook" && e.v.event === "asking"); i++) await Bun.sleep(20);
  const hook = noted().findLast((e) => e.kind === "hook").v;
  expect(hook).toMatchObject({ buf: 1, event: "asking", question: "Which database?" });
  expect(lua("vim.inspect({ require('corkboard.questions').answer(1, { { picks = { 5 } } }) })")).toContain("no such option");
  expect(lua("require('corkboard.questions').answer(1, { { picks = { 1 } } })")).toBe("true");
  expect((await asked).content[0].text).toBe("Which database? → SQLite");
  expect(noted().findLast((e) => e.kind === "hook").v).toMatchObject({ event: "tool_done" });
  s.stop();
});

test("an answer after the wait goes as the next prompt", async () => {
  const s = server(1);
  expect((await s.tool("ask", { questions: QUESTIONS })).content[0].text).toContain("hasn't answered yet");
  lua("require('corkboard.questions').answer(1, { { picks = {}, other = 'DuckDB' } })");
  expect(noted().findLast((e) => e.kind === "prompt").v).toBe("The answer to what you asked:\nWhich database? → DuckDB");
  expect(lua("require('corkboard.questions').pending(1) == nil")).toBe("true");
  s.stop();
});

test("a question with nothing to ask is an error", async () => {
  const s = server();
  const r = await s.tool("ask", { questions: [] });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe("ask at least one question");
  s.stop();
});
