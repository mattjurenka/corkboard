// A diagnostic, not a test: what a session's terminal (corkboard.terminal's
// start) and Neovim's own (jobstart's term) each make of a TUI, in a Neovim
// started as the bridge starts it (--embed, a UI attached). For the
// Windows runners, where a session's text came out garbled and uncoloured.
// Prints, for each program and each terminal: the bytes the pty gave
// (escaped), and the screen they left.
//
//   bun scripts/probe-terminal.ts [nvim] [--claude]

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMultiStream, encode } from "@msgpack/msgpack";

const args = process.argv.slice(2);
const nvim = args.find((a) => !a.startsWith("--")) ?? "nvim";
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "corkboard-probe-")));
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

// agent: the command is corkboard.agent.claude's (its hooks, its mod), with
// cmd's words after it. keys: sent to the program, each after its wait.
type Case = { name: string; cmd: string[]; wait: number; env?: Record<string, string>; cwd?: string; agent?: boolean; keys?: [number, string][] };
const cases: Case[] = [
  { name: "tui", cmd: [process.execPath, tui], wait: 3000 },
];
if (args.includes("--claude")) {
  cases.push({ name: "claude", cmd: ["claude"], wait: 20000, env: { CLAUDE_CONFIG_DIR: join(dir, "claude") } });
  // Past the first screens with a key that is no key, so a session starts,
  // its hooks run and its prompt is drawn; the request itself fails.
  const key = "sk-ant-api03-" + "0".repeat(95);
  const proj = join(dir, "proj");
  mkdirSync(proj);
  const seeded = (name: string) => {
    const config = join(dir, name);
    mkdirSync(config);
    const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    writeFileSync(join(config, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [proj]: trusted, [proj.replaceAll("\\", "/")]: trusted },
    }));
    return { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: key };
  };
  const keys: [number, string][] = [[12000, "\r"], [6000, "hello there"], [1000, "\r"]];
  cases.push({ name: "claude-seeded", cmd: ["claude"], wait: 30000, env: seeded("claude-plain"), cwd: proj, keys });
  cases.push({ name: "claude-corkboard", cmd: [], agent: true, wait: 30000, env: seeded("claude-agent"), cwd: proj, keys });
}

const LUA = String.raw`
local cases, result, plugin = ...
vim.opt.rtp:prepend(plugin)
-- No message to wait on a key no one presses.
vim.notify = function() end
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
        io.stderr:write(("probe: %s / %s\n"):format(c.name, how))
        vim.cmd.enew()
        local buf, raw = vim.api.nvim_get_current_buf(), {}
        local opts = {
          env = c.env,
          cwd = c.cwd,
          on_stdout = function(_, data) table.insert(raw, table.concat(data, "\n")) end,
        }
        local cmd = c.cmd
        if c.agent then
          local agent, env = require("corkboard.agent.claude").command({})
          cmd = vim.list_extend(agent, c.cmd)
          opts.env = vim.tbl_extend("force", env, c.env or {})
        end
        local started, job = pcall(function()
          if how == "start" then return require("corkboard.terminal").start(cmd, opts) end
          opts.term = true
          return vim.fn.jobstart(cmd, opts)
        end)
        local spent = 0
        for _, k in ipairs(c.keys or {}) do
          wait(k[1])
          spent = spent + k[1]
          if started then pcall(vim.fn.chansend, job, k[2]) end
        end
        wait(math.max(c.wait - spent, 0))
        local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
        while #lines > 0 and lines[#lines] == "" do table.remove(lines) end
        local size = { vim.fn.winwidth(0), vim.fn.winheight(0) }
        -- How many different highlights the window's cells have: 1 is no colour.
        vim.cmd.redraw()
        local attrs, pos = {}, vim.fn.win_screenpos(0)
        for r = pos[1], pos[1] + size[2] - 1 do
          for col = pos[2], pos[2] + size[1] - 1 do attrs[vim.fn.screenattr(r, col)] = true end
        end
        local all = table.concat(raw)
        table.insert(out.runs, {
          case = c.name, how = how, job = tostring(job), size = size, attrs = vim.tbl_count(attrs),
          cmd = table.concat(cmd, " "):sub(1, 400),
          raw = esc(all:sub(1, 3000)), tail = #all > 3000 and esc(all:sub(-math.min(#all - 3000, 5000))) or "", lines = lines,
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
const total = cases.reduce((n, c) => n + 2 * (c.wait + 5000), 30_000);
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
  console.log(`\n===== ${r.case} / ${r.how} (job ${r.job}, ${r.size.join("x")}, ${r.attrs} highlights) =====`);
  console.log(`--- cmd ${r.cmd}`);
  console.log("--- screen");
  for (const l of r.lines) console.log(`|${l}`);
  console.log("--- raw");
  console.log(r.raw);
  if (r.tail) console.log(`--- raw, its end\n${r.tail}`);
}
proc.kill();
process.exit(got.error ? 1 : 0);
