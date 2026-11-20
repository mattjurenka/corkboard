// navigate over a view's items as the page draws them: the panel by its
// window, its [data-nav] items where they are, and presses that come faster
// than Neovim's cursor.
import "@/testing/dom";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { navigate } from "./nav";

type At = [id: string, left: number, top: number];

// happy-dom lays nothing out, so each item says where it is.
function panel(win: number, items: At[], selected?: string) {
  const el = document.createElement("div");
  el.dataset.win = String(win);
  for (const [id, left, top] of items) {
    const item = document.createElement("div");
    item.dataset.nav = id;
    item.getBoundingClientRect = () => ({ left, top, right: left + 10, bottom: top + 10, width: 10, height: 10, x: left, y: top }) as DOMRect;
    // The selection is marked on something inside the item, as Board's Card is.
    const inner = item.appendChild(document.createElement("span"));
    if (id === selected) inner.dataset.selected = "";
    el.append(item);
  }
  document.body.append(el);
  return el;
}

// A grid, 10 wide with a gap of 10:
//   a b
//   c d
//   e f
const GRID: At[] = [
  ["a", 0, 0],
  ["b", 20, 0],
  ["c", 0, 20],
  ["d", 20, 20],
  ["e", 0, 40],
  ["f", 20, 40],
];

let clock = 0;
const now = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => now.mockRestore());
// Each test well after the last, so no press carries over.
afterEach(() => {
  document.body.innerHTML = "";
  clock += 10_000;
});

describe("navigate", () => {
  test("nothing without the window's panel, or with no items in it", () => {
    panel(1, GRID);
    expect(navigate(2, "down", "a")).toBeUndefined();
    panel(3, []);
    expect(navigate(3, "down", undefined)).toBeUndefined();
  });

  test("from the item Neovim names, the one that way", () => {
    panel(1, GRID);
    expect(navigate(1, "down", "a")).toBe("c");
    clock += 2000;
    expect(navigate(1, "right", "c")).toBe("d");
    clock += 2000;
    expect(navigate(1, "up", "a")).toBeUndefined();
  });

  test("an item it doesn't know goes from the selected one, and with none selected to the first", () => {
    panel(1, GRID, "d");
    expect(navigate(1, "down", "gone")).toBe("f");
    document.body.innerHTML = "";
    clock += 2000;
    panel(1, GRID);
    expect(navigate(1, "down", "gone")).toBe("a");
    clock += 2000;
    expect(navigate(1, "left", undefined)).toBe("a");
  });

  test("presses before Neovim's cursor has caught up each go on from the last", () => {
    panel(1, GRID);
    expect(navigate(1, "down", "a")).toBe("c");
    clock += 100;
    expect(navigate(1, "down", "a")).toBe("e");
    clock += 100;
    expect(navigate(1, "right", "a")).toBe("f");
    // Caught up, Neovim names where it is.
    clock += 100;
    expect(navigate(1, "up", "f")).toBe("d");
  });

  test("but not after a second, nor from another window, nor once Neovim names another item", () => {
    panel(1, GRID);
    panel(2, GRID);
    expect(navigate(1, "down", "a")).toBe("c");
    clock += 1000;
    expect(navigate(1, "down", "a")).toBe("c");
    clock += 100;
    expect(navigate(2, "down", "a")).toBe("c");
    clock += 100;
    expect(navigate(1, "down", "b")).toBe("d");
  });

  test("ids with quotes and the prototype's names are only themselves", () => {
    panel(1, [
      ["constructor", 0, 0],
      ["__proto__", 0, 20],
      ['x"y', 0, 40],
    ]);
    expect(navigate(1, "down", "constructor")).toBe("__proto__");
    clock += 2000;
    expect(navigate(1, "down", "__proto__")).toBe('x"y');
    clock += 2000;
    expect(navigate(1, "up", 'x"y')).toBe("__proto__");
  });
});
