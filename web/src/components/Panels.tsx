// HTML panels laid over the Neovim windows that host them.
//
// Neovim sends corkboard.layout with every window in the current tabpage
// that shows a view buffer, in grid cells. Each gets a panel positioned
// over that rectangle; the text Neovim draws underneath stays hidden.
// Floating windows come too, and each panel is clipped around them so a
// float opened over a panel (a card, a picker) shows through from the grid.
// Keyboard focus never leaves the canvas, so every key still goes to Neovim
// (a PDF's viewer can take it with a click; it comes back as the pointer
// leaves).
//
// The board's state is one per view; a file viewer's (corkboard.viewer) is
// per buffer, since two windows can show two different images.

import { keepFocus, useNvim } from "@/nvim/context";
import { type Rect, useStore } from "@/store";
import { VIEWS } from "@/views";

export function Panels() {
  const nvim = useNvim();
  const layout = useStore((s) => s.layout);
  const views = useStore((s) => s.views);
  const bufs = useStore((s) => s.bufs);
  const { w: cellW, h: cellH } = useStore((s) => s.cell);
  if (!layout) return null;
  return (
    <>
      {layout.views.map((w) => {
        const View = VIEWS[w.view];
        const state = bufs[w.buf] ?? views[w.view];
        return (
          <div
            // Another kind of view in the window (an image, then a PDF) is a
            // new panel.
            key={`${w.win}:${w.view}`}
            onMouseDown={keepFocus}
            className="absolute overflow-hidden bg-background select-none"
            style={{
              ...box(w, cellW, cellH),
              // A view in a float sits above the views in windows.
              zIndex: w.float ? 3 : 1,
              clipPath: w.float ? undefined : holes(w, layout.floats, cellW, cellH) || undefined,
            }}
          >
            {View && state && <View state={state} win={w.win} focused={!!w.focused} nvim={nvim} />}
          </div>
        );
      })}
      {/* A 1px outline around the focused window and its status line, absent
          when the tab is not split. Above the panels; clicks pass through. */}
      {layout.focus && (
        <div className="pointer-events-none absolute z-2 border border-focus" style={box(layout.focus, cellW, cellH)} />
      )}
    </>
  );
}

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
