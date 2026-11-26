// A diagnostic, not a test: what a session's terminal (corkboard.terminal's
// start) and Neovim's own (jobstart's term) each make of a TUI, in a Neovim
// started as the bridge starts it (--embed, a UI attached). For the
// Windows runners, where a session's text came out garbled and uncoloured.
// Prints, for each program and each terminal: the bytes the pty gave
// (escaped), and the screen they left.
//
//   bun scripts/probe-terminal.ts [nvim] [--claude]

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMultiStream, encode } from "@msgpack/msgpack";

const args = process.argv.slice(2);
const nvim = args.find((a) => !a.startsWith("--")) ?? "nvim";
const dir = mkdtempSync(join(tmpdir(), "corkboard-probe-"));
const result = join(dir, "result.json");

// Frames as Ink's log-update draws them (erase the last frame's lines, write
// the next), in colour; then a line feed alone, which should keep the column.
const TUI = String.raw`
const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out("tty:" + process.stdout.isTTY + " cols:" + process.stdout.columns + " TERM:" + process.env.TERM + "\n");
let last = 0;
for (const frame of [["one", "two", "three"], ["ONE", "TWO"], ["final \x1b[32mgreen\x1b[0m", "\x1b[38;2;255;100;0mtruecolor\x1b[0m end"]]) {
  let s = "";
  for (let i = 0; i < last; i++) s += "\x1b[2K" + (i < last - 1 ? "\x1b[1A" : "");
  if (last) s += "\x1b[G";
  s += frame.map((l) => "\x1b[1m" + l + "\x1b[22m").join("\n") + "\n";
  last = frame.length + 1;
  out(s);
  await sleep(300);
}
out("ab\x1b[1B\x1b[1Dcd\n");
await sleep(60000);
`;
const tui = join(dir, "tui.mjs");
writeFileSync(tui, TUI);

const cases: { name: string; cmd: string[]; wait: number; env?: Record<string, string> }[] = [
  { name: "tui", cmd: [process.execPath, tui], wait: 3000 },
];
if (args.includes("--claude")) {
  cases.push({ name: "claude", cmd: ["claude"], wait: 20000, env: { CLAUDE_CONFIG_DIR: join(dir, "claude") } });
}

const LUA = String.raw`
local cases, result, plugin = ...
vim.opt.rtp:prepend(plugin)
local function wait(ms)
  local co = coroutine.running()
  vim.defer_fn(function() coroutine.resume(co) end, ms)
  coroutine.yield()
end
local function esc(s)
  return (s:gsub("[%z\1-\31\127-\255]", function(c)
    if c == "\27" then return "\\e" elseif c == "\r" then return "\\r" elseif c == "\n" then return "\\n\n" end
    return ("\\x%02x"):format(c:byte())
  end))
end
coroutine.wrap(function()
  local out = { win32 = vim.fn.has("win32"), version = tostring(vim.version()), tgc = vim.o.termguicolors, runs = {} }
  local ok, err = xpcall(function()
    for _, c in ipairs(cases) do
      for _, how in ipairs({ "start", "term" }) do
        vim.cmd.enew()
        local buf, raw = vim.api.nvim_get_current_buf(), {}
        local opts = {
          env = c.env,
          on_stdout = function(_, data) table.insert(raw, table.concat(data, "\n")) end,
        }
        local started, job = pcall(function()
          if how == "start" then return require("corkboard.terminal").start(c.cmd, opts) end
          opts.term = true
          return vim.fn.jobstart(c.cmd, opts)
        end)
        wait(c.wait)
        local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
        while #lines > 0 and lines[#lines] == "" do table.remove(lines) end
        local size = { vim.fn.winwidth(0), vim.fn.winheight(0) }
        table.insert(out.runs, {
          case = c.name, how = how, job = tostring(job), size = size,
          raw = esc(table.concat(raw):sub(1, 6000)), lines = lines,
        })
        if started then pcall(vim.fn.jobstop, job) end
        wait(200)
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
      end
    end
  end, debug.traceback)
  if not ok then out.error = err end
  local f = assert(io.open(result, "w"))
  f:write(vim.json.encode(out))
  f:close()
end)()
`;

const proc = Bun.spawn([nvim, "--embed", "--clean"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
let id = 0;
const waiting = new Map<number, (v: unknown) => void>();
function call(method: string, ...params: unknown[]) {
  return new Promise((done) => {
    waiting.set(++id, done);
    proc.stdin.write(encode([0, id, method, params]));
    proc.stdin.flush();
  });
}
(async () => {
  for await (const m of decodeMultiStream(proc.stdout)) {
    const [type, mid, error, value] = m as [number, number, unknown, unknown];
    if (type === 1) waiting.get(mid)?.(error ?? value);
  }
})();

await call("nvim_ui_attach", 100, 30, { ext_linegrid: true, rgb: true });
console.log("exec:", await call("nvim_exec_lua", LUA, [cases, result, join(import.meta.dir, "..", "nvim")]));
const total = cases.reduce((n, c) => n + 2 * (c.wait + 1500), 10_000);
for (let t = 0; t < total && !existsSync(result); t += 250) await Bun.sleep(250);
if (!existsSync(result)) {
  console.error("probe: no result");
  proc.kill();
  process.exit(1);
}
const got = JSON.parse(readFileSync(result, "utf8"));
const { runs, ...about } = got;
console.log(JSON.stringify(about));
for (const r of runs ?? []) {
  console.log(`\n===== ${r.case} / ${r.how} (job ${r.job}, ${r.size.join("x")}) =====`);
  console.log("--- screen");
  for (const l of r.lines) console.log(`|${l}`);
  console.log("--- raw");
  console.log(r.raw);
}
proc.kill();
process.exit(got.error ? 1 : 0);
