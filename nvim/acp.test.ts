// How an ACP agent's ending is drawn in its conversation (corkboard/acp.lua's
// exited), in a real Neovim with the bridge stubbed: a failure's status and
// the end of its stderr, which bridge/acp.ts sends.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LUA = join(import.meta.dir, "lua");
const SCRIPT = join(mkdtempSync(join(tmpdir(), "corkboard-acp-")), "exited.lua");
writeFileSync(
  SCRIPT,
  `
    package.path = ${JSON.stringify(LUA + "/?.lua;" + LUA + "/?/init.lua;")} .. package.path
    package.loaded["corkboard.cards.cloud"] = { call_async = function() end, send = function() end, enabled = function() return false end }
    package.loaded["corkboard.away"] = { report = function() end }
    local input = vim.json.decode(io.read("*a"))
    local acp = require("corkboard.acp")
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_set_current_buf(buf)
    acp.start(buf, { name = "codex", label = "Codex", exe = "codex-acp" }, { cwd = vim.fn.getcwd() })
    acp.exited(buf, input.code, input.stderr)
    io.write(vim.json.encode(vim.api.nvim_buf_get_lines(buf, 0, -1, false)))`,
);

function exited(code: number | null, stderr?: string): string[] {
  const r = Bun.spawnSync(["nvim", "--headless", "--clean", "-l", SCRIPT], { stdin: Buffer.from(JSON.stringify({ code, stderr })) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return (JSON.parse(r.stdout.toString()) as string[]).filter((l) => l !== "");
}

test("a failure: its status, then the last of its stderr", () => {
  const stderr = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  expect(exited(1, stderr)).toEqual(["✗ codex-acp exited with status 1", "line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12", "— ended"]);
});

test("a failure with nothing on stderr: its status alone", () => {
  expect(exited(1, "  \n")).toEqual(["✗ codex-acp exited with status 1", "— ended"]);
  expect(exited(1)).toEqual(["✗ codex-acp exited with status 1", "— ended"]);
});

test("an end that isn't a failure: no word of its stderr", () => {
  expect(exited(0, "bye\n")).toEqual(["— ended"]);
  expect(exited(null, "killed\n")).toEqual(["— ended"]);
});
