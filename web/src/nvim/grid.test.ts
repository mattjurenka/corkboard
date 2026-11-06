// Ghosting on the canvas: a grid driven through a run of redraw events
// must end up with the same pixels as a fresh grid that only ever drew the
// final cells. The canvas is faked with one that rasterises like a browser's:
// fractional edges cover pixels partly and blend with what is there, and
// glyphs are boxes that may run wider or taller than their cell.
import { describe, expect, test } from "bun:test";

const CELL = 8.4; // "M"'s advance, so cellW is 9 and glyphs fall a little short
const GLYPH_W = new Map<string, number>([
  ["⏺", 1.6], // a fallback font's symbol, wider than its one cell
  ["✻", 1.4],
  ["🤖", 2.1],
  ["中", 2],
  ["W", 1.1],
]);
const GLYPH_H = new Map<string, number>([
  ["│", 1.52],
  ["┃", 1.52],
  ["╭", 1.5],
  ["g", 1.25],
]);

type Rect = { l: number; t: number; r: number; b: number };

class FakeCtx {
  font = "";
  fillStyle = "#000000";
  textBaseline = "alphabetic";
  scale = 1;
  clipRect: Rect | null = null;
  stack: (Rect | null)[] = [];
  path: Rect[] = [];
  constructor(private canvas: FakeCanvas) {}
  reset() {
    this.scale = 1;
    this.clipRect = null;
    this.stack = [];
    this.path = [];
  }
  setTransform(a: number) {
    this.scale = a;
  }
  measureText(text: string) {
    return { width: CELL * (GLYPH_W.get(text) ?? 1) };
  }
  save() {
    this.stack.push(this.clipRect);
  }
  restore() {
    this.clipRect = this.stack.pop() ?? null;
  }
  beginPath() {
    this.path = [];
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push(this.dev(x, y, w, h));
  }
  clip() {
    const p = this.path[0];
    const c = this.clipRect;
    this.clipRect = c ? { l: Math.max(c.l, p.l), t: Math.max(c.t, p.t), r: Math.min(c.r, p.r), b: Math.min(c.b, p.b) } : p;
  }
  dev(x: number, y: number, w: number, h: number): Rect {
    const s = this.scale;
    return { l: x * s, t: y * s, r: (x + w) * s, b: (y + h) * s };
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.canvas.paint(this.dev(x, y, w, h), this.fillStyle, this.clipRect);
  }
  // A glyph as a solid box from its origin, its middle on y.
  fillText(text: string, x: number, y: number) {
    const size = parseFloat(this.font.match(/([\d.]+)px/)![1]);
    const w = CELL * (GLYPH_W.get(text) ?? 0.9);
    const h = size * (GLYPH_H.get(text) ?? 1.1);
    this.canvas.paint(this.dev(x, y - h / 2, w, h), this.fillStyle, this.clipRect);
  }
}

class FakeCanvas {
  style: Record<string, string> = {};
  px = new Float64Array(0);
  w = 0;
  h = 0;
  ctx = new FakeCtx(this);
  // As on a real canvas, a new size clears it and resets the context.
  set width(v: number) {
    this.w = Math.trunc(v);
    this.alloc();
  }
  get width() {
    return this.w;
  }
  set height(v: number) {
    this.h = Math.trunc(v);
    this.alloc();
  }
  get height() {
    return this.h;
  }
  alloc() {
    this.px = new Float64Array(this.w * this.h * 3);
    this.ctx.reset();
  }
  getContext() {
    return this.ctx;
  }
  paint(r: Rect, style: string, clip: Rect | null) {
    if (clip) r = { l: Math.max(r.l, clip.l), t: Math.max(r.t, clip.t), r: Math.min(r.r, clip.r), b: Math.min(r.b, clip.b) };
    if (r.r <= r.l || r.b <= r.t) return;
    const n = parseInt(style.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (let y = Math.max(0, Math.floor(r.t)); y < Math.min(this.h, Math.ceil(r.b)); y++) {
      const cy = Math.min(y + 1, r.b) - Math.max(y, r.t);
      for (let x = Math.max(0, Math.floor(r.l)); x < Math.min(this.w, Math.ceil(r.r)); x++) {
        const cov = cy * (Math.min(x + 1, r.r) - Math.max(x, r.l));
        const i = (y * this.w + x) * 3;
        for (let c = 0; c < 3; c++) this.px[i + c] = this.px[i + c] * (1 - cov) + rgb[c] * cov;
      }
    }
  }
}

let dpr = 1;
Object.assign(globalThis, {
  window: {
    get devicePixelRatio() {
      return dpr;
    },
  },
  document: { documentElement: { style: { setProperty() {} } }, querySelector: () => null },
  getComputedStyle: () => ({ getPropertyValue: (k: string) => (k === "--font" ? "mono" : "14") }),
});
const { Grid } = await import("./grid.js");

const COLS = 24;
const ROWS = 8;
const HL: [number, object, object, object[]][] = [
  [1, { foreground: 0xe0e0e0, background: 0x202020 }, {}, []],
  [2, { foreground: 0xff8800, bold: true }, {}, []],
  [3, { foreground: 0x000000, background: 0x88ccff }, {}, []],
  [4, { foreground: 0x555555 }, {}, [{ ui_name: "WinSeparator" }]],
  [5, { foreground: 0xffffff, underline: true, italic: true }, {}, []],
  [6, { reverse: true }, {}, []],
];
const MODES = [
  { name: "normal", cursor_shape: "block", cell_percentage: 0, attr_id: 0 },
  { name: "insert", cursor_shape: "vertical", cell_percentage: 25, attr_id: 0 },
  { name: "replace", cursor_shape: "horizontal", cell_percentage: 20, attr_id: 3 },
];

type Event = [string, ...unknown[][]];

function make(scale: number) {
  dpr = scale;
  const canvas = new FakeCanvas();
  const grid = new Grid(canvas);
  grid.redraw([
    ["default_colors_set", [0xd0d0d0, 0x101418, 0xff0000]],
    ["hl_attr_define", ...HL],
    ["mode_info_set", [true, MODES]],
    ["grid_resize", [1, COLS, ROWS]],
    ["mode_change", ["normal", 0]],
    ["flush", []],
  ]);
  return { canvas, grid };
}

// What the grid should look like: its final cells drawn on a new canvas.
function fresh(g: InstanceType<typeof Grid>, scale: number) {
  const ref = make(scale);
  const lines = g.cells.map((line: { text: string; hl: number }[], row: number) => [1, row, 0, line.map((c) => [c.text, c.hl])]);
  const events: Event[] = [["grid_line", ...lines], ["grid_cursor_goto", [1, g.cursor.row, g.cursor.col]]];
  events.push(["mode_change", [g.modeName ?? "normal", g.mode]]);
  if (g.busy) events.push(["busy_start", []]);
  events.push(["flush", []]);
  ref.grid.redraw(events);
  return ref.canvas;
}

function ghosts(canvas: FakeCanvas, ref: FakeCanvas, g: InstanceType<typeof Grid>) {
  const out: string[] = [];
  for (let y = 0; y < canvas.h; y++)
    for (let x = 0; x < canvas.w; x++) {
      const i = (y * canvas.w + x) * 3;
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(canvas.px[i + c] - ref.px[i + c])));
      if (d > 1) {
        const row = Math.floor(y / dpr / g.cellH!);
        const col = Math.floor(x / dpr / g.cellW!);
        out.push(`px ${x},${y} (row ${row} col ${col} "${g.cells[row]?.[col]?.text}") off by ${d.toFixed(1)}`);
      }
    }
  return out;
}

function run(scale: number, steps: Event[][]) {
  const { canvas, grid } = make(scale);
  for (const events of steps) grid.redraw([...events, ["flush", []]]);
  const bad = ghosts(canvas, fresh(grid, scale), grid);
  return bad.length ? `${bad.length} stale pixels, first: ${bad.slice(0, 5).join("; ")}` : "";
}

const line = (row: number, col: number, text: string, hl = 1): Event => ["grid_line", [1, row, col, [...text].map((t, i) => (i ? [t] : [t, hl]))]];
const cells = (row: number, col: number, cs: [string, number?, number?][]): Event => ["grid_line", [1, row, col, cs]];
const blank = (row: number, hl = 1): Event => ["grid_line", [1, row, 0, [[" ", hl, COLS]]]];

const SCALES = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 3];

describe.each(SCALES)("at devicePixelRatio %p", (scale) => {
  test("text overwritten with blanks", () => {
    expect(run(scale, [[line(2, 0, "hello world gW")], [blank(2)]])).toBe("");
  });

  test("a line shortened", () => {
    expect(run(scale, [[line(1, 0, "⏺ Reading the whole file…")], [line(1, 0, "⏺ Done"), cells(1, 6, [[" ", 1, COLS - 6]])]])).toBe("");
  });

  test("an overhanging glyph's neighbour changes", () => {
    expect(run(scale, [[line(3, 0, "⏺✻⏺ x")], [cells(3, 1, [[" ", 1, 3]])], [cells(3, 0, [[" ", 1, 1]])]])).toBe("");
  });

  test("a wide character replaced by narrow ones", () => {
    expect(run(scale, [[cells(0, 0, [["🤖", 1], [""], ["中"], [""], ["a"]])], [line(0, 0, "abcde")]])).toBe("");
  });

  test("a wide character's continuation cell overwritten alone", () => {
    expect(run(scale, [[cells(0, 4, [["中", 2], [""]])], [cells(0, 5, [["x", 1]])]])).toBe("");
  });

  test("tall box-drawing glyphs, the rows around unchanged", () => {
    expect(run(scale, [[line(2, 0, "────"), line(3, 0, "│ ╭─ │"), line(4, 0, "gggg")], [blank(3)], [blank(2), blank(4)]])).toBe("");
  });

  test("window separators", () => {
    const sep = (row: number): Event => cells(row, 10, [["│", 4]]);
    expect(run(scale, [[sep(0), sep(1), sep(2)], [line(1, 8, "abcde")], [blank(1)]])).toBe("");
  });

  // Claude Code leaves the terminal's cursor after what's typed, so a bar
  // cursor walks right and back; :redraw! then repaints every row once.
  test("a bar cursor typed along a row and backed over, then all redrawn", () => {
    const text = "hello world";
    const steps: Event[][] = [[["mode_change", ["insert", 1]]]];
    for (let i = 0; i < text.length; i++) steps.push([line(5, 2 + i, text[i]), ["grid_cursor_goto", [1, 5, 3 + i]]]);
    for (let i = text.length - 1; i >= 0; i--) steps.push([cells(5, 2 + i, [[" ", 1]]), ["grid_cursor_goto", [1, 5, 2 + i]]]);
    steps.push([["grid_cursor_goto", [1, 0, 0]]]);
    steps.push([["grid_clear", []], ...Array.from({ length: ROWS }, (_, r) => blank(r))]);
    expect(run(scale, steps)).toBe("");
  });

  test("scrolling up and down a region", () => {
    const fill = Array.from({ length: ROWS }, (_, r) => line(r, 0, `${r} line ⏺ text ${"x".repeat(r)}`));
    expect(
      run(scale, [
        fill,
        [["grid_scroll", [1, 1, 6, 0, COLS, 2]], blank(4), blank(5)],
        [["grid_scroll", [1, 0, ROWS, 0, COLS, -3]], blank(0), blank(1), blank(2)],
        [["grid_scroll", [1, 2, 7, 4, 12, 1]], cells(6, 4, [[" ", 1, 8]])],
      ]),
    ).toBe("");
  });

  test("the cursor moving across rows and modes", () => {
    expect(
      run(scale, [
        [line(0, 0, "abc ⏺ def"), line(5, 0, "ghi")],
        [["grid_cursor_goto", [1, 0, 4]]],
        [["mode_change", ["insert", 1]], ["grid_cursor_goto", [1, 5, 1]]],
        [["mode_change", ["replace", 2]], ["grid_cursor_goto", [1, 2, 20]]],
        [["mode_change", ["normal", 0]], ["grid_cursor_goto", [1, 0, 0]]],
      ]),
    ).toBe("");
  });

  test("the cursor hidden and shown", () => {
    expect(
      run(scale, [
        [line(0, 0, "abcdef"), ["grid_cursor_goto", [1, 0, 3]]],
        [["busy_start", []]],
        [["grid_cursor_goto", [1, 4, 4]]],
        [["busy_stop", []]],
        [["busy_start", []], ["grid_cursor_goto", [1, 0, 3]], line(0, 0, "      ")],
      ]),
    ).toBe("");
  });

  test("underlined and reversed text cleared", () => {
    expect(run(scale, [[line(6, 0, "under lined", 5), line(7, 0, "reverse", 6)], [blank(6), blank(7)]])).toBe("");
  });

  test("block elements replaced", () => {
    expect(run(scale, [[line(1, 0, "▐▛███▜▌░▒▓▁▏", 2)], [line(1, 0, "  ▝▜█▛▘  ", 2)], [blank(1)]])).toBe("");
  });
});

// Random redraws, as a terminal running a TUI sends them.
const CHARS = ["a", "W", "g", " ", " ", " ", "⏺", "✻", "│", "─", "╭", "█", "▌", "░", "…", "中", "🤖"];
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}
function randomSteps(seed: number, n: number): Event[][] {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const int = (n: number) => Math.floor(r() * n);
  const steps: Event[][] = [];
  for (let s = 0; s < n; s++) {
    const events: Event[] = [];
    for (let k = int(4) + 1; k > 0; k--) {
      const kind = r();
      if (kind < 0.6) {
        const row = int(ROWS);
        let col = int(COLS);
        const cs: [string, number?, number?][] = [];
        while (col < COLS && cs.length < 12) {
          const ch = pick(CHARS);
          const hl = int(7);
          if ((ch === "中" || ch === "🤖") && col + 1 < COLS) {
            cs.push([ch, hl], [""]);
            col += 2;
          } else if (ch !== "中" && ch !== "🤖") {
            cs.push(r() < 0.2 ? [ch, hl, int(4) + 1] : [ch, hl]);
            col += cs[cs.length - 1][2] ?? 1;
          } else break;
        }
        events.push(["grid_line", [1, row, Math.max(0, col - cs.reduce((n, c) => n + (c[2] ?? 1), 0)), cs]]);
      } else if (kind < 0.75) {
        const top = int(ROWS - 2);
        const bot = top + 2 + int(ROWS - top - 1);
        const left = int(COLS / 2);
        const right = left + 1 + int(COLS - left);
        const rows = (int(bot - top - 1) + 1) * (r() < 0.5 ? 1 : -1);
        events.push(["grid_scroll", [1, top, bot, left, right, rows]]);
        const from = rows > 0 ? bot - rows : top;
        for (let row = from; row < from + Math.abs(rows); row++) events.push(cells(row, left, [[" ", 1, right - left]]));
      } else if (kind < 0.9) {
        events.push(["grid_cursor_goto", [1, int(ROWS), int(COLS)]]);
      } else if (kind < 0.95) {
        const m = int(3);
        events.push(["mode_change", [MODES[m].name, m]]);
      } else {
        events.push([r() < 0.5 ? "busy_start" : "busy_stop", []]);
      }
    }
    steps.push(events);
  }
  return steps;
}

describe.each(SCALES)("random redraws at devicePixelRatio %p", (scale) => {
  test.each(Array.from({ length: 25 }, (_, i) => i + 1))("seed %p", (seed) => {
    expect(run(scale, randomSteps(seed * 7919 + Math.round(scale * 100), 40))).toBe("");
  });
});
