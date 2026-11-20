// h/j/k/l over a view's items: which one is that way from here.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { type Dir, nearest } from "./nav";

const box = (left: number, top: number, width = 10, height = 10) => ({ left, top, right: left + width, bottom: top + height });
const item = (id: string, left: number, top: number, width?: number, height?: number) => ({ id, box: box(left, top, width, height) });
const go = (from: ReturnType<typeof box>, items: ReturnType<typeof item>[], dir: Dir) => nearest(from, items, dir)?.id;

describe("nearest", () => {
  // A grid of cards, 10 wide with a gap of 10:
  //   a b c
  //   d e f
  //   g h i
  const grid = ["abc", "def", "ghi"].flatMap((row, r) => [...row].map((id, c) => item(id, c * 20, r * 20)));
  const e = box(20, 20);

  test("each way from the middle of a grid", () => {
    expect(go(e, grid, "up")).toBe("b");
    expect(go(e, grid, "down")).toBe("h");
    expect(go(e, grid, "left")).toBe("d");
    expect(go(e, grid, "right")).toBe("f");
  });

  test("none past the edge", () => {
    expect(go(box(0, 0), grid.filter((i) => i.id !== "a"), "up")).toBeUndefined();
    expect(go(box(0, 0), grid.filter((i) => i.id !== "a"), "left")).toBeUndefined();
    expect(go(e, [], "down")).toBeUndefined();
  });

  test("one in line beats a nearer one off to the side", () => {
    // Below: x right under, but far; y near, but off to the right.
    const items = [item("x", 0, 100), item("y", 30, 15)];
    expect(go(box(0, 0), items, "down")).toBe("x");
    // And sideways: in the same rows beats nearer and higher.
    expect(go(box(0, 0), [item("x", 100, 5), item("y", 15, 40)], "right")).toBe("x");
  });

  test("of those off to the side, the nearest counting how far off", () => {
    const items = [item("far", 100, 50), item("near", 15, 30)];
    expect(go(box(0, 0), items, "down")).toBe("near");
  });

  test("of those in line, the nearest; then the one least skewed", () => {
    expect(go(box(0, 0), [item("x", 0, 60), item("y", 0, 30)], "down")).toBe("y");
    // A wide one and a narrow one, both under at the same distance.
    expect(go(box(10, 0), [item("wide", 0, 20, 40), item("narrow", 12, 20, 5)], "down")).toBe("narrow");
  });

  test("a shared border's pixel still counts as that way", () => {
    // Overlapping by a pixel (a border two boxes share).
    expect(go(box(0, 0), [item("x", 0, 9)], "down")).toBe("x");
    expect(go(box(0, 0), [item("x", 0, 8)], "down")).toBeUndefined();
    expect(go(box(0, 0), [item("x", 9, 0)], "right")).toBe("x");
  });

  test("columns of different widths: up from a wide card to the nearest over it", () => {
    const items = [item("left", 0, 0, 30), item("right", 40, 0, 30)];
    expect(go(box(0, 50, 70), items, "up")).toBe("left");
    expect(go(box(35, 50, 35), items, "up")).toBe("right");
  });
});

fuzz("nearest is that way, or nothing is", (g) => {
  const dirs: Dir[] = ["up", "down", "left", "right"];
  const rand = () => box(g.int(0, 200), g.int(0, 200), g.int(1, 60), g.int(1, 60));
  const items = Array.from({ length: g.size(12) }, (_, i) => ({ id: String(i), box: rand() }));
  const from = rand();
  const dir = g.pick(dirs);
  const to = nearest(from, items, dir);
  const ahead = (b: ReturnType<typeof box>) =>
    ({ down: b.top - from.bottom, up: from.top - b.bottom, right: b.left - from.right, left: from.left - b.right })[dir];
  if (!to) expect(items.every((i) => ahead(i.box) < -1)).toBe(true);
  else expect(ahead(to.box)).toBeGreaterThanOrEqual(-1);
});
