// Which card the session hook says a corkboard MCP tool took or let go of:
// the real hook, run as Claude Code runs it, against a real Neovim whose
// corkboard.agents only writes down what it's told. The panel beside a
// session lists that card, so an id the hook misreads is one it never shows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCardId } from "../../bridge/node/board";

const HOOK = join(import.meta.dir, "session.lua");
const dir = mkdtempSync(join(tmpdir(), "corkboard-hook-"));
const socket = join(dir, "nvim.sock");
const events = join(dir, "events");

const STUB = String.raw`
local path = os.getenv("EVENTS")
io.open(path, "w"):close()
package.loaded["corkboard.agents"] = {
  hook = function(ev)
    local f = io.open(path, "a")
    f:write(vim.json.encode(ev), "\n")
    f:close()
  end,
}
`;

let nvim: Subprocess;

beforeAll(async () => {
  const stub = join(dir, "stub.lua");
  writeFileSync(stub, STUB);
  nvim = Bun.spawn(["nvim", "--headless", "--clean", "--listen", socket, "-c", `luafile ${stub}`], {
    env: { ...process.env, EVENTS: events },
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

// What the session's Neovim hears when Claude Code runs the hook with this.
function run(fields: Record<string, unknown>) {
  const input = JSON.stringify({ session_id: "session", transcript_path: join(dir, "none.jsonl"), ...fields });
  const p = Bun.spawnSync(["nvim", "-l", HOOK], { stdin: Buffer.from(input), env: { ...process.env, NVIM: socket, CORKBOARD_BUF: "1" } });
  if (p.exitCode !== 0) throw new Error(`hook: ${p.stderr.toString()}`);
  return JSON.parse(readFileSync(events, "utf8").trim().split("\n").at(-1)!);
}

// ... when the tool returns this.
const hook = (tool: string, response: unknown) => run({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: {}, tool_response: response });

// A tool's result as Claude Code hands it over: the card's JSON as text,
// where other fields name other cards.
const result = (id: string, extra = {}) => [{ type: "text", text: JSON.stringify({ id, title: "A card", parent: "TASK-1", ...extra }, null, 2) }];

describe("the card a tool took", () => {
  // The ids the node makes now, whatever they come to, and the ones it made.
  const ids = ["TASK-7F3K", "TASK-F3K7", "BUG-12", ...Array.from({ length: 4 }, () => newCardId(["TASK-1"]))];

  test.each(ids)("claim_card on %s", (id) => {
    expect(hook("mcp__corkboard__claim_card", result(id))).toMatchObject({ corkboard_tool: "claim_card", card: id });
  });

  test("next_card", () => {
    expect(hook("mcp__corkboard__next_card", result("TASK-7F3K")).card).toBe("TASK-7F3K");
  });

  test("next_card with nothing to do", () => {
    expect(hook("mcp__corkboard__next_card", [{ type: "text", text: "null" }]).card).toBeUndefined();
  });

  test("release_card", () => {
    expect(hook("mcp__corkboard__release_card", result("TASK-7F3K"))).toMatchObject({ corkboard_tool: "release_card", card: "TASK-7F3K" });
  });

  test("a claim that failed", () => {
    expect(hook("mcp__corkboard__claim_card", [{ type: "text", text: "card TASK-7F3K is held by someone" }]).card).toBeUndefined();
  });

  test("a tool that takes no card", () => {
    expect(hook("mcp__corkboard__read_card", result("TASK-7F3K")).card).toBeUndefined();
  });
});

describe("Claude Code's events as corkboard's", () => {
  test.each([
    [{ hook_event_name: "SessionStart", source: "clear" }, { event: "start", source: "clear" }],
    [{ hook_event_name: "UserPromptSubmit" }, { event: "turn" }],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, { event: "tool", tool_name: "Bash" }],
    [{ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?" }] } }, { event: "asking", question: "Which?" }],
    [{ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: {} }, { event: "tool_done" }],
    [{ hook_event_name: "PermissionRequest", tool_name: "Bash" }, { event: "permission" }],
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, { event: "permission", noticed: true }],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt" }, { event: "waiting" }],
    [{ hook_event_name: "Notification", notification_type: "auth_success" }, { event: "notice" }],
    [{ hook_event_name: "Stop" }, { event: "settled" }],
  ])("%o", (input, want) => {
    expect(run(input)).toMatchObject({ ...want, session: "session", transcript: join(dir, "none.jsonl") });
  });

  test("a PermissionRequest isn't noticed", () => {
    expect(run({ hook_event_name: "PermissionRequest", tool_name: "Bash" }).noticed).toBeUndefined();
  });
});
