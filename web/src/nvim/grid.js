// Draws Neovim's ext_linegrid UI events onto a canvas.
// Single grid for now; ext_multigrid comes later.

const hex = (n) => "#" + n.toString(16).padStart(6, "0");

export class Grid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    const style = getComputedStyle(document.documentElement);
    this.fontFamily = style.getPropertyValue("--font").trim();
    this.fontSize = parseFloat(style.getPropertyValue("--font-size"));
    this.measure();

    this.cols = 0;
    this.rows = 0;
    this.cells = [];
    this.dirty = new Set();
    this.hl = new Map([[0, {}]]);
    this.defaults = { fg: 0xffffff, bg: 0x000000, sp: 0xff0000 };
    this.cursor = { row: 0, col: 0 };
    this.modes = [];
    this.mode = 0;
  }

  measure() {
    this.ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    this.cellW = Math.ceil(this.ctx.measureText("M").width);
    this.cellH = Math.ceil(this.fontSize * 1.3);
    // The panels and sidebar lay their text out on the same cells (h-row,
    // px-ch and the rest in index.css).
    const root = document.documentElement.style;
    root.setProperty("--cell-w", `${this.cellW}px`);
    root.setProperty("--cell-h", `${this.cellH}px`);
  }

  // A new cell size: the canvas is resized and cleared, so the caller asks
  // Neovim for a full redraw.
  setFont(family, size) {
    this.fontFamily = family;
    this.fontSize = size;
    this.measure();
    this.on_grid_resize(0, this.cols, this.rows);
  }

  // Grid size that fits the given CSS pixel box.
  fit(width, height) {
    return {
      cols: Math.max(20, Math.floor(width / this.cellW)),
      rows: Math.max(5, Math.floor(height / this.cellH)),
    };
  }

  redraw(batches) {
    for (const [name, ...calls] of batches) {
      const fn = this[`on_${name}`];
      if (fn) for (const args of calls) fn.apply(this, args);
    }
  }

  on_default_colors_set(fg, bg, sp) {
    if (fg >= 0) this.defaults.fg = fg;
    if (bg >= 0) this.defaults.bg = bg;
    if (sp >= 0) this.defaults.sp = sp;
    // The HTML panels take their palette from the colorscheme.
    const root = document.documentElement.style;
    root.setProperty("--nv-bg", hex(this.defaults.bg));
    root.setProperty("--nv-fg", hex(this.defaults.fg));
    // So does the title bar when installed as an app.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", hex(this.defaults.bg));
    this.markAll();
  }

  on_hl_attr_define(id, rgb) {
    this.hl.set(id, rgb);
  }

  on_grid_resize(_grid, cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = cols * this.cellW * dpr;
    this.canvas.height = rows * this.cellH * dpr;
    this.canvas.style.width = `${cols * this.cellW}px`;
    this.canvas.style.height = `${rows * this.cellH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.textBaseline = "middle";
    this.cells = Array.from({ length: rows }, () => this.blankRow());
    this.markAll();
  }

  on_grid_clear() {
    this.cells = this.cells.map(() => this.blankRow());
    this.markAll();
  }

  on_grid_line(_grid, row, col, cells) {
    const line = this.cells[row];
    if (!line) return;
    let hl = 0;
    for (const [text, hlId, repeat = 1] of cells) {
      if (hlId !== undefined) hl = hlId;
      for (let i = 0; i < repeat && col < this.cols; i++) line[col++] = { text, hl };
    }
    this.dirty.add(row);
  }

  on_grid_scroll(_grid, top, bot, left, right, rows) {
    const move = (to, from) => {
      for (let c = left; c < right; c++) this.cells[to][c] = this.cells[from][c];
      this.dirty.add(to);
    };
    if (rows > 0) for (let r = top; r < bot - rows; r++) move(r, r + rows);
    else for (let r = bot - 1; r >= top - rows; r--) move(r, r + rows);
  }

  on_grid_cursor_goto(_grid, row, col) {
    this.dirty.add(this.cursor.row);
    this.cursor = { row, col };
  }

  on_mode_info_set(_enabled, modes) {
    this.modes = modes;
  }

  on_mode_change(name, idx) {
    this.mode = idx;
    this.modeName = name;
    this.dirty.add(this.cursor.row);
  }

  on_flush() {
    this.dirty.add(this.cursor.row);
    for (const row of this.dirty) this.drawRow(row);
    this.dirty.clear();
    this.drawCursor();
  }

  blankRow() {
    return Array.from({ length: this.cols }, () => ({ text: " ", hl: 0 }));
  }

  markAll() {
    for (let r = 0; r < this.rows; r++) this.dirty.add(r);
  }

  colors(hlId) {
    const a = this.hl.get(hlId) ?? {};
    let fg = a.foreground ?? this.defaults.fg;
    let bg = a.background ?? this.defaults.bg;
    if (a.reverse) [fg, bg] = [bg, fg];
    return { a, fg, bg, sp: a.special ?? this.defaults.sp };
  }

  drawRow(row) {
    const line = this.cells[row];
    if (!line) return;
    const { ctx, cellW, cellH } = this;
    const y = row * cellH;
    for (let col = 0; col < line.length; col++) {
      const { text, hl } = line[col];
      const { a, fg, bg, sp } = this.colors(hl);
      const x = col * cellW;
      // A wide character's second cell arrives as "", so give the glyph room.
      const wide = line[col + 1]?.text === "" ? 2 : 1;
      ctx.fillStyle = hex(bg);
      ctx.fillRect(x, y, cellW * wide, cellH);
      if (text === "" || text === " ") continue;
      ctx.font = `${a.italic ? "italic " : ""}${a.bold ? "bold " : ""}${this.fontSize}px ${this.fontFamily}`;
      ctx.fillStyle = hex(fg);
      ctx.fillText(text, x, y + cellH / 2);
      if (a.underline || a.undercurl) {
        ctx.fillStyle = hex(a.undercurl ? sp : fg);
        ctx.fillRect(x, y + cellH - 2, cellW * wide, 1);
      }
      if (a.strikethrough) {
        ctx.fillStyle = hex(fg);
        ctx.fillRect(x, y + cellH / 2, cellW * wide, 1);
      }
    }
  }

  drawCursor() {
    const { row, col } = this.cursor;
    const cell = this.cells[row]?.[col];
    if (!cell) return;
    const mode = this.modes[this.mode] ?? {};
    const { ctx, cellW, cellH } = this;
    const x = col * cellW;
    const y = row * cellH;
    const pct = (mode.cell_percentage || 100) / 100;
    const { fg, bg } = this.colors(cell.hl);
    const cursorHl = mode.attr_id ? this.colors(mode.attr_id) : null;
    const color = cursorHl?.a.background !== undefined ? cursorHl.bg : fg;

    ctx.fillStyle = hex(color);
    if (mode.cursor_shape === "vertical") {
      ctx.fillRect(x, y, Math.max(1, cellW * pct), cellH);
    } else if (mode.cursor_shape === "horizontal") {
      ctx.fillRect(x, y + cellH * (1 - pct), cellW, Math.max(1, cellH * pct));
    } else {
      ctx.fillRect(x, y, cellW, cellH);
      ctx.fillStyle = hex(cursorHl?.a.foreground !== undefined ? cursorHl.fg : bg);
      ctx.fillText(cell.text, x, y + cellH / 2);
    }
  }

  // Canvas pixel position to grid cell, for mouse input.
  cellAt(px, py) {
    return {
      row: Math.min(this.rows - 1, Math.max(0, Math.floor(py / this.cellH))),
      col: Math.min(this.cols - 1, Math.max(0, Math.floor(px / this.cellW))),
    };
  }
}
