// A panel's clip-path around the floats over it: the panel's own rectangle,
// then one hole per rectangle the floats cover, none overlapping (evenodd
// would fill an overlap back in), together exactly the cells covered.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { box, holes } from "./clip";

type Rect = { row: number; col: number; width: number; height: number };
const W = 10;
const H = 20;

// The path's rectangles, in cells; the first is the panel.
function rects(path: string) {
  const m = /^path\(evenodd, "(.*)"\)$/.exec(path);
  if (!m) throw new Error(`not a path: ${path}`);
  return [...m[1].matchAll(/M(\d+) (\d+)H(\d+)V(\d+)H(\d+)Z/g)].map(([, l, t, r, b, l2]) => {
    expect(l2).toBe(l);
    return { left: +l / W, top: +t / H, right: +r / W, bottom: +b / H };
  });
}

// Each cell of w: how many of the holes cover it, against whether a float does.
function check(w: Rect, floats: Rect[]) {
  const path = holes(w, floats, W, H);
  const covers = (f: Rect, r: number, c: number) => w.row + r >= f.row && w.row + r < f.row + f.height && w.col + c >= f.col && w.col + c < f.col + f.width;
  const any = Array.from({ length: w.height }, (_, r) => Array.from({ length: w.width }, (_, c) => floats.some((f) => covers(f, r, c))));
  if (!any.flat().some(Boolean)) return expect(path).toBe("");
  const [panel, ...cut] = rects(path);
  expect(panel).toEqual({ left: 0, top: 0, right: w.width, bottom: w.height });
  for (let r = 0; r < w.height; r++)
    for (let c = 0; c < w.width; c++) {
      const n = cut.filter((h) => r >= h.top && r < h.bottom && c >= h.left && c < h.right).length;
      expect([r, c, n]).toEqual([r, c, any[r][c] ? 1 : 0]);
    }
  return cut;
}

describe("holes", () => {
  const w = { row: 2, col: 4, width: 20, height: 10 };

  test("none when no float is over it", () => {
    expect(holes(w, [], W, H)).toBe("");
    expect(holes(w, [{ row: 20, col: 4, width: 5, height: 5 }], W, H)).toBe("");
    expect(holes(w, [{ row: 2, col: 0, width: 4, height: 5 }], W, H)).toBe("");
    expect(holes(w, [{ row: 3, col: 5, width: 0, height: 5 }], W, H)).toBe("");
  });

  test("one float is one hole, in the panel's own pixels", () => {
    expect(holes(w, [{ row: 4, col: 6, width: 3, height: 2 }], W, H)).toBe('path(evenodd, "M0 0H200V200H0ZM20 40H50V80H20Z")');
  });

  test("a float hanging over the edge is cut to the panel", () => {
    expect(check(w, [{ row: 0, col: 0, width: 8, height: 4 }])).toEqual([{ left: 0, top: 0, right: 4, bottom: 2 }]);
    check(w, [{ row: 10, col: 20, width: 30, height: 30 }]);
  });

  test("a picker: a bordered box and the windows in it are one hole", () => {
    const cut = check(w, [
      { row: 3, col: 6, width: 12, height: 6 },
      { row: 4, col: 7, width: 10, height: 1 },
      { row: 5, col: 7, width: 10, height: 3 },
    ]);
    expect(cut).toHaveLength(1);
  });

  test("overlapping floats make holes that don't overlap", () => {
    check(w, [
      { row: 3, col: 5, width: 6, height: 4 },
      { row: 5, col: 8, width: 6, height: 4 },
    ]);
  });

  test("box is the rectangle in pixels", () => {
    expect(box({ row: 2, col: 3, width: 4, height: 5 }, 9, 18)).toEqual({ left: 27, top: 36, width: 36, height: 90 });
  });
});

fuzz("holes are the floats' cells, each once", (g) => {
  const w = { row: g.int(0, 5), col: g.int(0, 5), width: g.int(1, 16), height: g.int(1, 12) };
  const floats = Array.from({ length: g.size(5) }, () => ({ row: g.int(0, 20), col: g.int(0, 24), width: g.int(0, 10), height: g.int(0, 8) }));
  check(w, floats);
}, { runs: 300 });
