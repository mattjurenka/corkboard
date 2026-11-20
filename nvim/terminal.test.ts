// A session's terminal (corkboard.terminal's start): the process on a pty,
// its output into a terminal buffer through the filter that takes out what
// Neovim would draw as <200b> where the program counted no columns. The
// filter alone, split every way; then start in a Neovim whose main loop
// runs, so typed keys reach the process and the window's size is its own.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox({ repo: false });
afterAll(() => box.cleanup());

const cp = (n: number) => String.fromCodePoint(n);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// No columns to Bun.stringWidth, six to Neovim's terminal.
const DROPPED = [0x070f, 0x180e, 0x200b, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2060, 0x206f), 0xfeff];
// Their neighbours, and ZWNJ, ZWJ and the Mongolian selectors, which join
// the character before them.
const KEPT = [0x070e, 0x0710, 0x180b, 0x180c, 0x180d, 0x180f, 0x200a, 0x200c, 0x200d, 0x2010, 0x2029, 0x202f, 0x205f, 0x2070, 0xfefe, 0xfff8, 0xfffc, 0xfffd];

// Each list of chunks through a filter of its own, then eof. Bytes go both
// ways as hex: a chunk can end inside a character.
const HEX = `local function bytes(h) return (h:gsub("%x%x", function(x) return string.char(tonumber(x, 16)) end)) end
local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end
local out = {}
for _, chunks in ipairs(input) do
  local f, s = require("corkboard.terminal").filter(), ""
  for _, c in ipairs(chunks) do s = s .. f(bytes(c)) end
  table.insert(out, hex(s .. f("", true)))
end
return out`;
function filtered(inputs: (string | Buffer)[][]): Buffer[] {
  const hex = box.lua<string[]>(HEX, inputs.map((chunks) => chunks.map((c) => Buffer.from(c).toString("hex"))));
  return hex.map((h) => Buffer.from(h, "hex"));
}
const text = (inputs: string[][]) => filtered(inputs).map((b) => b.toString());

describe("the filter", () => {
  test("takes out what Neovim draws as <200b>", () => {
    expect(text(DROPPED.map((c) => [`a${cp(c)}b`]))).toEqual(DROPPED.map(() => "ab"));
  });

  test("leaves their neighbours and the joiners", () => {
    expect(text(KEPT.map((c) => [`a${cp(c)}b`]))).toEqual(KEPT.map((c) => `a${cp(c)}b`));
  });

  test("gives U+FFF9-FFFB, one column to the program and six to Neovim, as U+FFFD", () => {
    expect(text([0xfff9, 0xfffa, 0xfffb].map((c) => [`a${cp(c)}b`]))).toEqual(["a\u{fffd}b", "a\u{fffd}b", "a\u{fffd}b"]);
  });

  // Every character it knows, among ones that start with the same bytes,
  // cut in two at every byte.
  test("waits for the rest of a character cut off at a chunk's end", () => {
    const around = (c: string) => `${c}─é\u{1F600}`;
    const all = Buffer.from([...DROPPED, ...KEPT, 0xfff9].map((c) => around(cp(c))).join("") + "\x1b[2K");
    const want = [...DROPPED.map(() => ""), ...KEPT.map(cp), "\u{fffd}"].map(around).join("") + "\x1b[2K";
    const cuts = Array.from({ length: all.length - 1 }, (_, i) => [all.subarray(0, i + 1), all.subarray(i + 1)]);
    const out = filtered([[all], ...cuts]).map((b) => b.toString());
    expect(out[0]).toBe(want);
    expect(out.filter((s) => s !== want)).toEqual([]);
  });

  test("lets go of a character's start at eof", () => {
    const out = filtered([[Buffer.from("a\xe2", "latin1")], [Buffer.from("a\xe2\x80", "latin1")], [Buffer.from("a\xef\xbf", "latin1")]]);
    expect(out.map((b) => b.toString("hex"))).toEqual(["61e2", "61e280", "61efbf"]);
  });
});

// The code in a Neovim whose main loop runs (-c, not -l), as a coroutine:
// wait(cond) lets it go round until cond() holds, so typed keys and the
// terminal's output are handled. What the code returns comes back as JSON.
const LIVE = String.raw`
vim.opt.rtp:prepend(os.getenv("CORKBOARD_TEST_PLUGIN"))
vim.o.columns, vim.o.lines = 60, 20
function _G.wait(cond, ms)
  local co, start = coroutine.running(), vim.uv.now()
  repeat
    vim.defer_fn(function() coroutine.resume(co) end, 10)
    coroutine.yield()
  until cond() or vim.uv.now() - start > (ms or 5000)
  return cond()
end
function _G.lines() return vim.tbl_filter(function(l) return l ~= "" end, vim.api.nvim_buf_get_lines(0, 0, -1, false)) end
coroutine.wrap(function()
  wait(function() return vim.fn.winwidth(0) == 60 end)
  local ok, result = xpcall(assert(loadfile(os.getenv("CORKBOARD_TEST_CODE"))), debug.traceback)
  local out = assert(io.open(os.getenv("CORKBOARD_TEST_RESULT"), "w"))
  out:write(vim.json.encode(ok and { result = result == nil and vim.NIL or result } or { error = result }))
  out:close()
  vim.cmd("qa!")
end)()
`;
let runs = 0;
function live<T = any>(code: string): T {
  const n = ++runs;
  const files = { runner: join(box.dir, "live.lua"), code: join(box.dir, `live${n}.lua`), result: join(box.dir, `live${n}.out`) };
  writeFileSync(files.runner, LIVE);
  writeFileSync(files.code, code);
  const r = Bun.spawnSync(["nvim", "--headless", "--clean", "-c", `luafile ${files.runner}`], {
    cwd: box.repo,
    env: { ...box.env, CORKBOARD_TEST_CODE: files.code, CORKBOARD_TEST_RESULT: files.result },
    stdin: "ignore",
    timeout: 15_000,
  });
  let out: { result?: T; error?: string };
  try {
    out = JSON.parse(readFileSync(files.result, "utf8"));
  } catch {
    throw new Error(`nvim exited ${r.exitCode} with no result: ${r.stderr.toString()}`);
  }
  if (out.error !== undefined) throw new Error(out.error);
  return out.result as T;
}

describe("start", () => {
  test("runs the command on a pty the window's size, its output filtered into the buffer", () => {
    const r = live(String.raw`
      local seen = {}
      vim.api.nvim_create_autocmd("TermOpen", { callback = function(a) seen.pid = vim.b[a.buf].terminal_job_pid end })
      local job = require("corkboard.terminal").start({ "sh", "-c", [[printf 'a\342\200\213b|%s|%s|' "$TERM" $$; stty size; sleep 5]] }, { cwd = vim.fn.getcwd() })
      wait(function() return lines()[1] and lines()[1]:find("|%d+ %d+") end)
      local buf = vim.api.nvim_get_current_buf()
      return {
        lines = lines(), job = job, id = vim.b.terminal_job_id, pid = vim.b.terminal_job_pid, seen = seen.pid,
        jobpid = vim.fn.jobpid(job), name = vim.api.nvim_buf_get_name(buf), buftype = vim.bo.buftype,
        width = vim.fn.winwidth(0) - vim.fn.getwininfo(vim.fn.win_getid())[1].textoff, height = vim.fn.winheight(0),
      }
    `);
    expect(r.id).toBe(r.job);
    expect(r.pid).toBe(r.jobpid);
    // Set before the terminal, for TermOpen's handlers (corkboard's click-to-open).
    expect(r.seen).toBe(r.pid);
    expect(r.buftype).toBe("terminal");
    expect(r.name).toBe(`term://${box.repo.replace(box.home, "~")}//${r.pid}:sh -c printf 'a\\342\\200\\213b|%s|%s|' "$TERM" $$; stty size; sleep 5`);
    expect(r.lines).toEqual([`ab|xterm-256color|${r.pid}|${r.height} ${r.width}`]);
  });

  test("types what's typed into it, and tells the process its new size", () => {
    const r = live(String.raw`
      require("corkboard.terminal").start({ "sh", "-c", "read l; echo got:$l; stty size; read l; stty size; sleep 5" }, {})
      vim.cmd.startinsert()
      vim.api.nvim_input("hello<CR>")
      wait(function() return #lines() >= 3 end)
      local before = lines()[3]
      vim.cmd.stopinsert()
      wait(function() return vim.fn.mode() == "n" end)
      vim.cmd("vsplit")
      vim.cmd("vertical resize 25")
      -- A UI's redraw fires it; there is none here.
      vim.cmd("doautocmd WinResized")
      wait(function() return false end, 200)
      vim.cmd.startinsert()
      vim.api.nvim_input("x<CR>")
      wait(function() return #lines() >= 5 end)
      return { lines = lines(), before = before, widths = vim.tbl_map(vim.fn.winwidth, vim.api.nvim_tabpage_list_wins(0)), height = vim.fn.winheight(0) }
    `);
    expect(r.lines.slice(0, 2)).toEqual(["hello", "got:hello"]);
    expect(r.before).toBe(`${r.height} 60`);
    // The smallest of the windows showing it.
    expect(r.lines[4]).toBe(`${r.height} ${Math.min(...r.widths)}`);
  });

  test("hands on_stdout the filtered bytes, NULs and all, and EOF once", () => {
    const r = live(String.raw`
      local got, eofs = {}, 0
      require("corkboard.terminal").start({ "sh", "-c", [[printf 'x\000y\342\200\213z\n'; printf 'w\342'; sleep 0.1; printf '\200\213v']] }, {
        on_stdout = function(_, data)
          if #data == 1 and data[1] == "" then eofs = eofs + 1 else table.insert(got, table.concat(data, "\n")) end
        end,
      })
      wait(function() return eofs > 0 end)
      local s = table.concat(got)
      return { hex = (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)), eofs = eofs }
    `);
    expect(Buffer.from(r.hex, "hex").toString()).toBe("x\0yz\r\nwv");
    expect(r.eofs).toBe(1);
  });

  test("on exit, says so as :terminal does, keeps the status and closes it", () => {
    const r = live(String.raw`
      local closed, code = 0, nil
      local buf = vim.api.nvim_get_current_buf()
      vim.api.nvim_create_autocmd("TermClose", { buffer = buf, callback = function() closed = closed + 1 end })
      require("corkboard.terminal").start({ "sh", "-c", "echo bye; exit 3" }, { on_exit = function(_, c) code = c end })
      wait(function() return closed > 0 end)
      wait(function() return false end, 100)
      local said = vim.tbl_map(function(m) return m[4].virt_text[1][1] end,
        vim.api.nvim_buf_get_extmarks(buf, vim.api.nvim_create_namespace("nvim.terminal.exitmsg"), 0, -1, { details = true }))
      return { lines = lines(), said = said, status = vim.b[buf].corkboard_exit_status, code = code, closed = closed, alive = require("corkboard.terminal").alive(buf) }
    `);
    // As :terminal says it, over the text, not in it.
    expect(r).toEqual({ lines: ["bye"], said: ["[Process exited 3]"], status: 3, code: 3, closed: 1, alive: false });
  });

  test("stops the process with its buffer, as :terminal does", () => {
    const r = live(String.raw`
      local job = require("corkboard.terminal").start({ "sleep", "30" }, {})
      local running = vim.fn.jobwait({ job }, 0)[1]
      vim.cmd("enew")
      vim.cmd("bwipeout! #")
      return { running = running, after = vim.fn.jobwait({ job }, 2000)[1] }
    `);
    expect(r.running).toBe(-1);
    expect(r.after).not.toBe(-1);
  });
});
