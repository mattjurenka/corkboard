// attachInput on a real <canvas> and <textarea> with the browser's own
// events (input.test.ts drives it with bare EventTargets): focus, which goes
// to the grid unless the on-screen keyboard has it, the textarea's text and
// caret put back, a paste from a real clipboard event, and KeyboardEvent,
// InputEvent and PointerEvent as the browser makes them.
import "@/testing/dom";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { attachInput, MAC } from "./input.js";

const sent: unknown[][] = [];
const take = () => sent.splice(0);
const rpc = { notify: (...a: unknown[]) => void sent.push(a) };
const grid = {
  modeName: "normal" as string | undefined,
  cellW: 10,
  cellH: 20,
  cols: 80,
  rows: 24,
  cellAt: (x: number, y: number) => ({ row: Math.floor(y / 20), col: Math.floor(x / 10) }),
};
let wins: { row: number; col: number; width: number; height: number }[] | undefined;

const canvas = document.createElement("canvas");
canvas.tabIndex = 0;
canvas.getBoundingClientRect = () => ({ left: 100, top: 50, right: 900, bottom: 530, width: 800, height: 480, x: 100, y: 50 }) as DOMRect;
canvas.setPointerCapture = () => {};
const keys = document.createElement("textarea");
const other = document.createElement("input");
document.body.append(canvas, keys, other);

beforeAll(() => attachInput(canvas, keys, grid, rpc, () => wins));
afterEach(() => {
  take();
  grid.modeName = "normal";
  wins = undefined;
  other.focus();
});

// An event at a cell, in the canvas's coordinates.
const at = (row: number, col: number) => ({ clientX: 100 + col * 10 + 3, clientY: 50 + row * 20 + 5 });
const fire = (target: EventTarget, e: Event) => (target.dispatchEvent(e), e.defaultPrevented);
const keydown = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

test("this page isn't a Mac's", () => expect(MAC).toBe(false));

describe("keys", () => {
  test("KeyboardEvents as the browser makes them go in as Neovim's keys, and the browser does nothing with them", () => {
    expect(fire(canvas, keydown({ key: "j", code: "KeyJ" }))).toBe(true);
    expect(fire(canvas, keydown({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(fire(keys, keydown({ key: "Tab", code: "Tab", shiftKey: true }))).toBe(true);
    expect(fire(canvas, keydown({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBe(false);
    expect(take()).toEqual([
      ["nvim_input", "j"],
      ["nvim_input", "<C-S-p>"],
      ["nvim_input", "<S-Tab>"],
    ]);
  });

  test("a key from elsewhere on the page isn't the grid's", () => {
    expect(fire(other, keydown({ key: "j", code: "KeyJ" }))).toBe(false);
    expect(take()).toEqual([]);
  });

  test("Ctrl+C copies in visual mode, and is Ctrl+C elsewhere", () => {
    grid.modeName = "visual";
    expect(fire(canvas, keydown({ key: "c", code: "KeyC", ctrlKey: true }))).toBe(true);
    grid.modeName = "terminal";
    fire(canvas, keydown({ key: "c", code: "KeyC", ctrlKey: true }));
    expect(take()).toEqual([
      ["nvim_input", '"+y'],
      ["nvim_input", "<C-c>"],
    ]);
  });

  test("Ctrl+V in insert mode is left to the browser, to paste", () => {
    grid.modeName = "insert";
    expect(fire(canvas, keydown({ key: "v", code: "KeyV", ctrlKey: true }))).toBe(false);
    expect(take()).toEqual([]);
  });
});

describe("paste", () => {
  test("from a real clipboard event, as one paste", () => {
    const data = new DataTransfer();
    data.setData("text/plain", "two\nlines");
    const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    expect(fire(keys, e)).toBe(true);
    expect(take()).toEqual([["nvim_paste", "two\nlines", true, -1]]);
  });
});

describe("the on-screen keyboard", () => {
  test("the textarea starts with two spaces and its caret after them", () => {
    expect(keys.value).toBe("  ");
    expect([keys.selectionStart, keys.selectionEnd]).toEqual([2, 2]);
  });

  test("InputEvents: text, Backspace and Enter, and the textarea put back each time", () => {
    keys.value = "  a<";
    fire(keys, new InputEvent("input", { inputType: "insertText", data: "a<" }));
    expect(keys.value).toBe("  ");
    expect(keys.selectionStart).toBe(2);
    keys.value = " ";
    fire(keys, new InputEvent("input", { inputType: "deleteContentBackward" }));
    fire(keys, new InputEvent("input", { inputType: "insertLineBreak" }));
    fire(keys, new InputEvent("input", { inputType: "insertParagraph" }));
    expect(take()).toEqual([
      ["nvim_input", "a<lt>"],
      ["nvim_input", "<BS>"],
      ["nvim_input", "<CR>"],
      ["nvim_input", "<CR>"],
    ]);
  });

  test("a word being composed goes in when it's done", () => {
    fire(keys, new InputEvent("input", { inputType: "insertCompositionText", data: "ni", isComposing: true }));
    expect(take()).toEqual([]);
    // happy-dom's CompositionEvent is a bare Event, with no data of its own.
    fire(keys, Object.assign(new CompositionEvent("compositionend"), { data: "你" }));
    expect(take()).toEqual([["nvim_input", "你"]]);
  });
});

describe("focus", () => {
  test("a click on the grid gives it focus, from anywhere on the page", () => {
    expect(document.activeElement).toBe(other);
    expect(fire(canvas, new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...at(1, 2) }))).toBe(true);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, ...at(1, 2) }));
    expect(document.activeElement).toBe(canvas);
    expect(take()).toEqual([
      ["nvim_input_mouse", "left", "press", "", 0, 1, 2],
      ["nvim_input_mouse", "left", "release", "", 0, 1, 2],
    ]);
  });

  test("but while the on-screen keyboard is up, a tap leaves it up", () => {
    keys.focus();
    const touch = (type: string) =>
      fire(canvas, new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, ...at(3, 4) }));
    expect(touch("pointerdown")).toBe(true);
    touch("pointerup");
    expect(document.activeElement).toBe(keys);
    expect(take()).toEqual([
      ["nvim_input_mouse", "left", "press", "", 0, 3, 4],
      ["nvim_input_mouse", "left", "release", "", 0, 3, 4],
    ]);
  });

  test("a tap with the keyboard down focuses the grid", () => {
    const touch = (type: string) => fire(canvas, new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 8, ...at(0, 0) }));
    touch("pointerdown");
    touch("pointerup");
    expect(document.activeElement).toBe(canvas);
  });
});

describe("the mouse", () => {
  test("a drag let go of outside the grid still ends there", () => {
    fire(canvas, new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...at(0, 0) }));
    fire(canvas, new MouseEvent("mousemove", { bubbles: true, ...at(2, 2), shiftKey: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 0 }));
    expect(take().map((c) => c.slice(1, 4))).toEqual([
      ["left", "press", ""],
      ["left", "drag", "S"],
      ["left", "release", ""],
    ]);
  });

  test("the resize cursor is set on the canvas's own style", () => {
    wins = [
      { row: 0, col: 0, width: 10, height: 5 },
      { row: 0, col: 11, width: 10, height: 5 },
    ];
    fire(canvas, new MouseEvent("mousemove", { bubbles: true, ...at(2, 10) }));
    expect(canvas.style.cursor).toBe("col-resize");
    fire(canvas, new MouseEvent("mousemove", { bubbles: true, ...at(2, 3) }));
    expect(canvas.style.cursor).toBe("");
  });

  test("the context menu is Neovim's", () => {
    expect(fire(canvas, new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))).toBe(true);
  });

  test("a WheelEvent scrolls, and the page doesn't", () => {
    // happy-dom's WheelEvent is a UIEvent, not a MouseEvent: where it is and
    // its modifiers are put on it.
    const wheel = (init: WheelEventInit) =>
      Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }), {
        clientX: { value: at(4, 4).clientX },
        clientY: { value: at(4, 4).clientY },
        ctrlKey: { value: false },
        altKey: { value: false },
        shiftKey: { value: false },
      });
    expect(fire(canvas, wheel({ deltaY: 120 }))).toBe(true);
    fire(canvas, wheel({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE }));
    expect(take()).toEqual([
      ["nvim_input_mouse", "wheel", "down", "", 0, 4, 4],
      ["nvim_input_mouse", "wheel", "up", "", 0, 4, 4],
    ]);
  });
});
