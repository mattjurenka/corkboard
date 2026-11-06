// Ghosting in the terminal itself: a TUI that measures text as Claude Code
// does (Ink's string-width, which Bun.stringWidth follows) draws frames in a
// real Neovim :terminal, and the screen it leaves must be its last frame.
// Where Neovim gives a character a different width, the TUI's cursor maths
// is off from there on and what it meant to overwrite stays.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COLS = 40;
const ROWS = 12;
const dir = mkdtempSync(join(tmpdir(), "corkboard-term-"));

// The TUI. "widths" prints each character and asks the terminal where its
// cursor went (DSR); the others draw the frames: "diff" writes only the
// cells that changed at absolute positions, "relative" the same with
// relative moves, "log" erases the last frame's lines and writes the next,
// as Ink's log-update does.
const TUI = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const [mode, input, output] = process.argv.slice(2);
const data = JSON.parse(readFileSync(input, "utf8"));
const out = (s) => process.stdout.write(s);
const seg = new Intl.Segmenter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "widths") {
  process.stdin.setRawMode(true);
  let buf = "";
  process.stdin.on("data", (d) => (buf += d.toString()));
  const result = {};
  for (const ch of data) {
    buf = "";
    out("\r\x1b[2K" + ch + "\x1b[6n");
    for (let i = 0; i < 200 && !/\x1b\[\d+;\d+R/.test(buf); i++) await sleep(5);
    const m = buf.match(/\x1b\[(\d+);(\d+)R/);
    result[ch] = m ? Number(m[2]) - 1 : -1;
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}

// A line as cells: a grapheme, then "" for each further column it takes.
const layout = (line) => {
  const cells = [];
  for (const { segment } of seg.segment(line)) {
    const w = Bun.stringWidth(segment);
    if (w === 0 && cells.length) cells[cells.length - 1] += segment;
    else cells.push(segment, ...Array(Math.max(0, w - 1)).fill(""));
  }
  return cells;
};

out("\x1b[?25l\x1b[2J\x1b[H");
let prev = [];
let cur = { row: 0, col: 0 };
const move = (row, col) => {
  if (cur.row === row && cur.col === col) return;
  if (mode === "relative") {
    out("\r");
    if (row > cur.row) out("\x1b[" + (row - cur.row) + "B");
    if (row < cur.row) out("\x1b[" + (cur.row - row) + "A");
    if (col) out("\x1b[" + col + "C");
  } else out("\x1b[" + (row + 1) + ";" + (col + 1) + "H");
  cur = { row, col };
};
for (const frame of data) {
  if (mode === "log") {
    if (prev.length) out("\x1b[2K\x1b[1A".repeat(prev.length - 1) + "\x1b[2K\x1b[G");
    out(frame.join("\n"));
  } else {
    for (let row = 0; row < Math.max(frame.length, prev.length); row++) {
      const a = layout(prev[row] ?? "");
      const b = layout(frame[row] ?? "");
      for (let col = 0; col < b.length; col++) {
        if (a[col] === b[col] || b[col] === "") continue;
        move(row, col);
        out(b[col]);
        cur.col += Bun.stringWidth(b[col]);
      }
      if (b.length < a.length) {
        move(row, b.length);
        out("\x1b[K");
      }
    }
  }
  prev = frame;
  await sleep(20);
}
out("\x1b[?25h");
`;
const tui = join(dir, "tui.mjs");
writeFileSync(tui, TUI);

// Neovim runs the TUI in a terminal buffer and hands back that buffer's lines.
const HARNESS = String.raw`
local spec = vim.json.decode(io.open(os.getenv("SPEC")):read("a"))
vim.o.columns = spec.cols
vim.o.lines = spec.rows + 2
vim.o.laststatus = 0
vim.cmd("enew")
local job = vim.fn.jobstart({ "bun", spec.tui, spec.mode, spec.input, spec.output }, { term = true })
vim.wait(20000, function() return vim.fn.jobwait({ job }, 0)[1] ~= -1 end, 10)
vim.wait(200)
if spec.mode ~= "widths" then
  local f = io.open(spec.output, "w")
  f:write(vim.json.encode(vim.api.nvim_buf_get_lines(0, 0, -1, false)))
  f:close()
end
vim.cmd("qa!")
`;
const harness = join(dir, "harness.lua");
writeFileSync(harness, HARNESS);

let n = 0;
function inTerminal(mode: string, data: unknown) {
  const id = n++;
  const input = join(dir, `in-${id}.json`);
  const output = join(dir, `out-${id}.json`);
  const spec = join(dir, `spec-${id}.json`);
  writeFileSync(input, JSON.stringify(data));
  writeFileSync(spec, JSON.stringify({ cols: COLS, rows: ROWS, tui, mode, input, output }));
  const p = Bun.spawnSync(["nvim", "--headless", "--clean", "-l", harness], { env: { ...process.env, SPEC: spec } });
  if (p.exitCode !== 0) throw new Error(`nvim: ${p.stderr.toString()}`);
  return JSON.parse(readFileSync(output, "utf8"));
}

function screen(mode: string, frames: string[][]) {
  const lines: string[] = inTerminal(mode, frames);
  return lines.slice(0, ROWS).map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
}
const last = (frames: string[][]) => frames[frames.length - 1].map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");

// What Claude Code draws: its spinner and status glyphs, the logo's blocks,
// emoji with and without presentation selectors, and East Asian text.
const CHARS = [
  "⏺", "✻", "✢", "✳", "✶", "✽", "·", "⎿", "⏵", "⏸", "⧉", "↯", "❯", "›", "…", "→", "↑", "↓", "•",
  "✔", "✓", "✗", "✘", "⚠", "⚡", "★", "☐", "☒", "◯", "●", "○", "◐", "▶", "▸",
  "▐", "▛", "█", "▜", "▌", "▝", "▘", "░", "▒", "▓", "─", "│", "╭", "╮", "╰", "╯",
  "⚠️", "✔️", "❤️", "☑️", "⏺️", "▶️", "✳️",
  "🤖", "🔥", "✅", "❌", "🚀", "📝", "👍", "👍🏽", "👨‍💻", "🏳️‍🌈", "🇺🇸",
  "中", "あ", "한", "ｱ", "Ａ", "é", "ñ", "á", "​",
];

describe("widths", () => {
  const terminal: Record<string, number> = inTerminal("widths", CHARS);
  test.each(CHARS)("the terminal gives %p as many columns as Bun.stringWidth", (ch) => {
    expect({ ch, terminal: terminal[ch] }).toEqual({ ch, terminal: Bun.stringWidth(ch) });
  });
});

describe.each(["diff", "relative", "log"])("a %s renderer", (mode) => {
  // A status line whose last few cells change, after the glyph.
  test.each(CHARS)("redraws the text after %p", (ch) => {
    const frames = [[`${ch} Reading files`, "next line"], [`${ch} Reading fixes`, "next lint"]];
    expect(screen(mode, frames)).toBe(last(frames));
  });

  // The glyph itself changing, as the spinner does.
  test.each(CHARS)("swaps %p for a spinner frame", (ch) => {
    const frames = [[`${ch} Thinking… (3s)`], [`✻ Thinking… (4s)`], [`${ch} Thinking… (5s)`]];
    expect(screen(mode, frames)).toBe(last(frames));
  });

  // A line that just fills the width by Bun.stringWidth: a wider glyph in
  // the terminal wraps it, and the frame after is a row off.
  test.each(CHARS)("clears a full-width line holding %p", (ch) => {
    const fill = (s: string) => s + "x".repeat(Math.max(0, COLS - Bun.stringWidth(s)));
    const frames = [[fill(`╭ ${ch} `), fill("│ "), fill("╰ ")], ["done"]];
    expect(screen(mode, frames)).toBe(last(frames));
  });
});

describe("Claude Code's screens", () => {
  const logo = [" ▐▛███▜▌   Claude Code", "▝▜█████▛▘  Opus", "  ▘▘ ▝▝    ~/corkboard"];
  const tool = (s: string) => [...logo, "", `⏺ Read(web/src/nvim/grid.js)`, `  ⎿  ${s}`, "", `✻ Working… (${s.length}s · ↑ 1.2k tokens)`];
  test.each(["diff", "relative", "log"])("a tool call finishing, by a %s renderer", (mode) => {
    const frames = [tool("Reading 345 lines"), tool("Read 345 lines"), tool("⚠️ Done"), tool("✔ ok")];
    expect(screen(mode, frames)).toBe(last(frames));
  });
  test.each(["diff", "relative", "log"])("a todo list ticking off, by a %s renderer", (mode) => {
    const todos = (done: number) => ["⏺ Update Todos", ...["write tests", "run them", "fix 🐛"].map((t, i) => `  ⎿  ${i < done ? "☒" : "☐"} ${t}`)];
    const frames = [todos(0), todos(1), todos(2), todos(3)];
    expect(screen(mode, frames)).toBe(last(frames));
  });
});
