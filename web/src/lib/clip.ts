// Where a panel over the grid goes, in pixels, and the floats over it it
// lets through (Panels.tsx, Skeleton.tsx, Scrollbars.tsx).

import type { Rect } from "@/store";

export const box = (r: Rect, cellW: number, cellH: number) => ({
  left: r.col * cellW,
  top: r.row * cellH,
  width: r.width * cellW,
  height: r.height * cellH,
});

// A clip-path that cuts the floats over this rectangle out of it. Clipped
// areas also drop out of hit testing, so clicks there reach the canvas.
//
// Floats overlap (a picker is a bordered box with windows inside it), and
// under evenodd two overlapping holes fill back in. So the floats are first
// merged cell by cell into rectangles that do not overlap.
export function holes(w: Rect, floats: Rect[], cellW: number, cellH: number) {
  const covered = Array.from({ length: w.height }, () => new Uint8Array(w.width));
  let any = false;
  for (const f of floats) {
    const top = Math.max(f.row, w.row) - w.row;
    const left = Math.max(f.col, w.col) - w.col;
    const bottom = Math.min(f.row + f.height, w.row + w.height) - w.row;
    const right = Math.min(f.col + f.width, w.col + w.width) - w.col;
    for (let r = top; r < bottom; r++) covered[r].fill(1, left, Math.max(left, right));
    any ||= bottom > top && right > left;
  }
  if (!any) return "";

  // Runs of covered cells per row; a run that repeats on the next row
  // extends the rectangle above it instead of starting a new one.
  type Run = { top: number; left: number; right: number; bottom?: number };
  const rects: Run[] = [];
  let open = new Map<string, Run>(); // "left:right" -> rect
  for (let r = 0; r <= w.height; r++) {
    const next = new Map<string, Run>();
    for (let c = 0; r < w.height && c < w.width; c++) {
      if (!covered[r][c]) continue;
      const left = c;
      while (c < w.width && covered[r][c]) c++;
      const key = `${left}:${c}`;
      const rect = open.get(key) ?? { top: r, left, right: c };
      rect.bottom = r + 1;
      next.set(key, rect);
    }
    for (const [key, rect] of open) if (!next.has(key)) rects.push(rect);
    open = next;
  }

  const path = (top: number, left: number, bottom: number, right: number) =>
    `M${left * cellW} ${top * cellH}H${right * cellW}V${bottom * cellH}H${left * cellW}Z`;
  return `path(evenodd, "${path(0, 0, w.height, w.width)}${rects.map((r) => path(r.top, r.left, r.bottom!, r.right)).join("")}")`;
}
