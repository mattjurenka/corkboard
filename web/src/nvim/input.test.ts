// The browser's keys, mouse, touch and paste as Neovim's input: toNvimKey
// and windowKey off a Mac and on one, and attachInput driven through a
// canvas and a textarea that are bare EventTargets, with an rpc that keeps
// what it's told.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { attachInput, MAC, toNvimKey, windowKey } from "./input.js";

type Init = Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing: boolean }>;
const key = (init: Init) => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...init });

// input.js again, as a Mac's page has it: MAC is read once, at load.
async function onMac() {
  const was = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  try {
    return (await import(`./input.js?${"mac"}`)) as typeof import("./input.js");
  } finally {
    if (was) Object.defineProperty(navigator, "platform", was);
    else delete (navigator as { platform?: string }).platform;
  }
}

describe("toNvimKey, off a Mac", () => {
  test("this isn't a Mac", () => expect(MAC).toBe(false));

  test("a printable key is itself, Shift already in it", () => {
    expect(toNvimKey(key({ key: "a", code: "KeyA" }))).toBe("a");
    expect(toNvimKey(key({ key: "A", code: "KeyA", shiftKey: true }))).toBe("A");
    expect(toNvimKey(key({ key: "?", code: "Slash", shiftKey: true }))).toBe("?");
    expect(toNvimKey(key({ key: "中" }))).toBe("中");
    expect(toNvimKey(key({ key: "😀" }))).toBe("😀");
    expect(toNvimKey(key({ key: "<", shiftKey: true }))).toBe("<lt>");
    expect(toNvimKey(key({ key: " ", code: "Space" }))).toBe(" ");
  });

  test("named keys, with their modifiers", () => {
    expect(toNvimKey(key({ key: "Enter" }))).toBe("<CR>");
    expect(toNvimKey(key({ key: "Escape" }))).toBe("<Esc>");
    expect(toNvimKey(key({ key: "Backspace", ctrlKey: true }))).toBe("<C-BS>");
    expect(toNvimKey(key({ key: "Tab", shiftKey: true }))).toBe("<S-Tab>");
    expect(toNvimKey(key({ key: "ArrowUp", altKey: true, shiftKey: true }))).toBe("<A-S-Up>");
    expect(toNvimKey(key({ key: "F12" }))).toBe("<F12>");
    expect(toNvimKey(key({ key: "PageDown", metaKey: true }))).toBe("<D-PageDown>");
  });

  test("chords", () => {
    expect(toNvimKey(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBe("<C-c>");
    // Ctrl+Shift on a letter is sent as such, Neovim falling back to <C-p>.
    expect(toNvimKey(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("<C-S-p>");
    // Shift on a symbol is in the symbol.
    expect(toNvimKey(key({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }))).toBe("<C-{>");
    expect(toNvimKey(key({ key: "x", altKey: true }))).toBe("<A-x>");
    expect(toNvimKey(key({ key: "x", metaKey: true }))).toBe("<D-x>");
    expect(toNvimKey(key({ key: " ", code: "Space", ctrlKey: true }))).toBe("<C-Space>");
    expect(toNvimKey(key({ key: "\\", ctrlKey: true }))).toBe("<C-Bslash>");
    expect(toNvimKey(key({ key: "<", ctrlKey: true }))).toBe("<C-lt>");
    expect(toNvimKey(key({ key: "0", code: "Numpad0", ctrlKey: true }))).toBe("<C-k0>");
  });

  test("Alt+digit by the key, whatever the layout puts there", () => {
    expect(toNvimKey(key({ key: "¡", code: "Digit1", altKey: true }))).toBe("<A-1>");
    expect(toNvimKey(key({ key: "!", code: "Digit1", altKey: true, shiftKey: true }))).toBe("<A-!>");
    expect(toNvimKey(key({ key: "1", code: "Digit1", altKey: true, ctrlKey: true }))).toBe("<C-A-1>");
  });

  test("Wayland's Unidentified Ctrl chords by their code", () => {
    expect(toNvimKey(key({ key: "Unidentified", code: "Space", ctrlKey: true }))).toBe("<C-Space>");
    expect(toNvimKey(key({ key: "Unidentified", code: "Backquote", ctrlKey: true }))).toBe("<C-`>");
    expect(toNvimKey(key({ key: "Unidentified", code: "KeyQ", ctrlKey: true }))).toBe("<C-q>");
    expect(toNvimKey(key({ key: "Unidentified", code: "Digit7", ctrlKey: true }))).toBe("<C-7>");
    // An on-screen keyboard's 229, which the textarea's input event takes.
    expect(toNvimKey(key({ key: "Unidentified", code: "" }))).toBeNull();
  });

  test("not ours: modifiers alone, dead keys, composition", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process"]) expect(toNvimKey(key({ key: k }))).toBeNull();
    expect(toNvimKey(key({ key: "a", isComposing: true }))).toBeNull();
    expect(toNvimKey(key({ key: "Enter", isComposing: true }))).toBeNull();
  });
});

describe("windowKey, off a Mac", () => {
  test("Alt+h/j/k/l and Alt+arrows", () => {
    expect(windowKey(key({ key: "h", altKey: true }))).toBe("h");
    expect(windowKey(key({ key: "L", altKey: true, shiftKey: true }))).toBe("l");
    expect(windowKey(key({ key: "ArrowDown", altKey: true }))).toBe("j");
    expect(windowKey(key({ key: "ArrowUp", altKey: true }))).toBe("k");
  });
  test("nothing else", () => {
    expect(windowKey(key({ key: "h" }))).toBeNull();
    expect(windowKey(key({ key: "x", altKey: true }))).toBeNull();
    expect(windowKey(key({ key: "h", altKey: true, ctrlKey: true }))).toBeNull();
    expect(windowKey(key({ key: "h", altKey: true, metaKey: true }))).toBeNull();
    expect(windowKey(key({ key: "Alt", altKey: true }))).toBeNull();
  });
});

describe("on a Mac", () => {
  let mac: typeof import("./input.js");
  beforeAll(async () => {
    mac = await onMac();
  });

  test("it is one, and the page off it is still not", () => {
    expect(mac.MAC).toBe(true);
    expect(MAC).toBe(false);
  });

  test("Option alone types what the layout has there", () => {
    expect(mac.toNvimKey(key({ key: "@", code: "KeyL", altKey: true }))).toBe("@");
    expect(mac.toNvimKey(key({ key: "<", code: "Comma", altKey: true }))).toBe("<lt>");
    expect(mac.toNvimKey(key({ key: "Dead", code: "KeyE", altKey: true }))).toBeNull();
    expect(mac.toNvimKey(key({ key: "Unidentified", code: "KeyE", altKey: true }))).toBeNull();
  });

  test("macOS's editing keys", () => {
    expect(mac.toNvimKey(key({ key: "ArrowLeft", altKey: true }))).toBe("<M-b>");
    expect(mac.toNvimKey(key({ key: "ArrowRight", altKey: true }))).toBe("<M-f>");
    expect(mac.toNvimKey(key({ key: "Backspace", altKey: true }))).toBe("<C-w>");
    expect(mac.toNvimKey(key({ key: "ArrowLeft", metaKey: true }))).toBe("<Home>");
    expect(mac.toNvimKey(key({ key: "Backspace", metaKey: true }))).toBe("<C-u>");
    expect(mac.toNvimKey(key({ key: "ArrowRight", metaKey: true, shiftKey: true }))).toBe("<S-End>");
    expect(mac.toNvimKey(key({ key: "ArrowLeft", altKey: true, shiftKey: true }))).toBe("<C-S-Left>");
  });

  test("a Cmd chord by the key pressed, and only one corkboard maps", () => {
    expect(mac.toNvimKey(key({ key: "p", code: "KeyP", metaKey: true }))).toBe("<D-p>");
    expect(mac.toNvimKey(key({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))).toBe("<D-S-p>");
    expect(mac.toNvimKey(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }))).toBe("<D-S-[>");
    expect(mac.toNvimKey(key({ key: "3", code: "Digit3", metaKey: true }))).toBe("<D-3>");
    expect(mac.toNvimKey(key({ key: "˙", code: "KeyH", altKey: true, metaKey: true }))).toBe("<A-D-h>");
    expect(mac.toNvimKey(key({ key: "ArrowLeft", altKey: true, metaKey: true }))).toBe("<A-D-Left>");
    // Cmd+Q, Cmd+C: the browser's.
    expect(mac.toNvimKey(key({ key: "q", code: "KeyQ", metaKey: true }))).toBeNull();
    expect(mac.toNvimKey(key({ key: "c", code: "KeyC", metaKey: true }))).toBeNull();
    // Unless a key is being bound.
    expect(mac.toNvimKey(key({ key: "q", code: "KeyQ", metaKey: true }), true)).toBe("<D-q>");
  });

  test("Ctrl+Option goes as it would elsewhere", () => {
    expect(mac.toNvimKey(key({ key: "∂", code: "KeyD", altKey: true, ctrlKey: true }))).toBe("<C-A-d>");
    expect(mac.toNvimKey(key({ key: "d", code: "KeyD", ctrlKey: true, metaKey: true }), true)).toBe("<C-D-d>");
  });

  test("setCmdKeys adds the chords Neovim maps, in any spelling", () => {
    const x = key({ key: "≈", code: "KeyX", altKey: true, metaKey: true });
    const k = key({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(mac.toNvimKey(x)).toBeNull();
    expect(mac.toNvimKey(k)).toBeNull();
    mac.setCmdKeys(["<M-D-x>", "<D-K>"]);
    expect(mac.toNvimKey(x)).toBe("<A-D-x>");
    expect(mac.toNvimKey(k)).toBe("<D-S-k>");
    // Its own stay.
    expect(mac.toNvimKey(key({ key: "p", code: "KeyP", metaKey: true }))).toBe("<D-p>");
    mac.setCmdKeys([]);
    expect(mac.toNvimKey(x)).toBeNull();
  });

  test("windowKey is Cmd+Option, by the key", () => {
    expect(mac.windowKey(key({ key: "¬", code: "KeyL", altKey: true, metaKey: true }))).toBe("l");
    expect(mac.windowKey(key({ key: "ArrowUp", altKey: true, metaKey: true }))).toBe("k");
    expect(mac.windowKey(key({ key: "h", code: "KeyH", altKey: true }))).toBeNull();
    expect(mac.windowKey(key({ key: "x", code: "KeyX", altKey: true, metaKey: true }))).toBeNull();
  });
});

// ---- attachInput

type Call = unknown[];
const sent: Call[] = [];
const rpc = { notify: (...a: unknown[]) => void sent.push(a) };
const grid = {
  modeName: "normal" as string | undefined,
  cellW: 10,
  cellH: 20,
  cols: 80,
  rows: 24,
  cellAt: (x: number, y: number) => ({ row: Math.floor(y / 20), col: Math.floor(x / 10) }),
};
let focused = 0;
const canvas = Object.assign(new EventTarget(), {
  style: { cursor: "" },
  focus: () => void focused++,
  setPointerCapture: () => {},
  getBoundingClientRect: () => ({ left: 100, top: 50 }),
});
const keys = Object.assign(new EventTarget(), {
  value: "",
  selection: [0, 0],
  setSelectionRange(a: number, b: number) {
    this.selection = [a, b];
  },
});
let wins: { row: number; col: number; width: number; height: number }[] | undefined;

const ev = (type: string, props: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), props);
// An event at a cell, in the canvas's coordinates.
const at = (row: number, col: number) => ({ clientX: 100 + col * 10 + 3, clientY: 50 + row * 20 + 5 });
const fire = (target: EventTarget, e: Event) => (target.dispatchEvent(e), e.defaultPrevented);
const take = () => sent.splice(0);

const saved = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
const win = new EventTarget();
beforeAll(() => {
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true, writable: true });
  attachInput(canvas, keys, grid, rpc, () => wins);
});
afterAll(() => {
  for (const [name, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, name, d);
    else delete (globalThis as Record<string, unknown>)[name]; // keys: "window" and "document"
  }
});
beforeEach(() => {
  take();
  grid.modeName = "normal";
  wins = undefined;
});

describe("attachInput: keys", () => {
  test("a key goes to Neovim from the canvas or the textarea, and the browser does nothing with it", () => {
    expect(fire(canvas, ev("keydown", key({ key: "j", code: "KeyJ" })))).toBe(true);
    expect(fire(keys, ev("keydown", key({ key: "Enter" })))).toBe(true);
    expect(take()).toEqual([
      ["nvim_input", "j"],
      ["nvim_input", "<CR>"],
    ]);
  });

  test("a key that isn't ours is the browser's", () => {
    expect(fire(canvas, ev("keydown", key({ key: "Shift", shiftKey: true })))).toBe(false);
    expect(fire(canvas, ev("keydown", key({ key: "a", isComposing: true })))).toBe(false);
    expect(take()).toEqual([]);
  });

  test("Ctrl+V pastes where text is typed, and is Vim's visual block elsewhere", () => {
    const ctrlV = () => ev("keydown", key({ key: "v", code: "KeyV", ctrlKey: true }));
    for (const mode of ["insert", "replace", "cmdline_normal", "cmdline_insert", "terminal", "visual_select"]) {
      grid.modeName = mode;
      expect(fire(canvas, ctrlV())).toBe(false);
    }
    expect(take()).toEqual([]);
    grid.modeName = "normal";
    expect(fire(canvas, ctrlV())).toBe(true);
    expect(take()).toEqual([["nvim_input", "<C-v>"]]);
    // Ctrl+Shift+V in any mode.
    expect(fire(canvas, ev("keydown", key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true })))).toBe(false);
    expect(take()).toEqual([]);
  });

  test("Ctrl+C copies a selection, and is Ctrl+C everywhere else", () => {
    const ctrlC = (shiftKey = false) => ev("keydown", key({ key: shiftKey ? "C" : "c", code: "KeyC", ctrlKey: true, shiftKey }));
    grid.modeName = "visual";
    expect(fire(canvas, ctrlC())).toBe(true);
    grid.modeName = "visual_line";
    expect(fire(canvas, ctrlC(true))).toBe(true);
    grid.modeName = "visual_select";
    expect(fire(canvas, ctrlC())).toBe(true);
    grid.modeName = "terminal";
    expect(fire(canvas, ctrlC())).toBe(true);
    grid.modeName = undefined;
    expect(fire(canvas, ctrlC())).toBe(true);
    expect(take()).toEqual([
      ["nvim_input", '"+y'],
      ["nvim_input", '"+y'],
      ["nvim_input", '<C-g>"+ygv<C-g>'],
      ["nvim_input", "<C-c>"],
      ["nvim_input", "<C-c>"],
    ]);
  });

  test("a paste goes in as one, from the system clipboard", () => {
    const e = ev("paste", { clipboardData: { getData: (t: string) => (t === "text" ? "a\nb<c>" : "") } });
    expect(fire(keys, e)).toBe(true);
    expect(take()).toEqual([["nvim_paste", "a\nb<c>", true, -1]]);
  });
});

describe("attachInput: the on-screen keyboard", () => {
  test("its text goes in with < and newlines as keys, and the textarea is put back", () => {
    keys.value = "  x";
    fire(keys, ev("input", { inputType: "insertText", data: "a<b\nc", isComposing: false }));
    expect(take()).toEqual([["nvim_input", "a<lt>b<CR>c"]]);
    expect(keys.value).toBe("  ");
    expect(keys.selection).toEqual([2, 2]);
  });

  test("Backspace and Enter as keys", () => {
    fire(keys, ev("input", { inputType: "deleteContentBackward", data: null }));
    fire(keys, ev("input", { inputType: "insertLineBreak", data: null }));
    fire(keys, ev("input", { inputType: "insertParagraph", data: null }));
    expect(take()).toEqual([
      ["nvim_input", "<BS>"],
      ["nvim_input", "<CR>"],
      ["nvim_input", "<CR>"],
    ]);
  });

  test("a word being composed goes when it's finished", () => {
    keys.value = "  ni";
    fire(keys, ev("input", { inputType: "insertCompositionText", data: "ni", isComposing: true }));
    expect(take()).toEqual([]);
    expect(keys.value).toBe("  ni");
    fire(keys, ev("compositionend", { data: "你" }));
    expect(take()).toEqual([["nvim_input", "你"]]);
    expect(keys.value).toBe("  ");
    // An empty one says nothing.
    fire(keys, ev("compositionend", { data: "" }));
    fire(keys, ev("input", { inputType: "insertText", data: "" }));
    expect(take()).toEqual([]);
  });
});

describe("attachInput: the mouse", () => {
  test("a click and a drag at the cells under it, with its modifiers", () => {
    const before = focused;
    expect(fire(canvas, ev("mousedown", { button: 0, ...at(2, 3), ctrlKey: true, shiftKey: true, altKey: false }))).toBe(true);
    fire(canvas, ev("mousemove", { ...at(3, 5), ctrlKey: false, shiftKey: false, altKey: true }));
    fire(win, ev("mouseup", { ...at(4, 6), ctrlKey: false, shiftKey: false, altKey: false }));
    expect(take()).toEqual([
      ["nvim_input_mouse", "left", "press", "CS", 0, 2, 3],
      ["nvim_input_mouse", "left", "drag", "A", 0, 3, 5],
      ["nvim_input_mouse", "left", "release", "", 0, 4, 6],
    ]);
    expect(focused).toBe(before + 1);
    // Released, a move only sets the cursor.
    fire(canvas, ev("mousemove", at(0, 0)));
    fire(win, ev("mouseup", at(0, 0)));
    expect(take()).toEqual([]);
  });

  test("middle and right buttons, and none for the others", () => {
    fire(canvas, ev("mousedown", { button: 2, ...at(1, 1) }));
    fire(win, ev("mouseup", at(1, 1)));
    fire(canvas, ev("mousedown", { button: 1, ...at(1, 1) }));
    fire(win, ev("mouseup", at(1, 1)));
    expect(fire(canvas, ev("mousedown", { button: 3, ...at(1, 1) }))).toBe(true);
    fire(win, ev("mouseup", at(1, 1)));
    expect(take().map((c) => c.slice(1, 3))).toEqual([
      ["right", "press"],
      ["right", "release"],
      ["middle", "press"],
      ["middle", "release"],
    ]);
    expect(fire(canvas, ev("contextmenu"))).toBe(true);
  });

  test("the resize cursor over a split's separator and status line, but not the last one's", () => {
    // Two side by side over two stacked: 0..9 | 11..20, rows 0..4, then a
    // status line at row 5, and one at row 11 at the bottom.
    wins = [
      { row: 0, col: 0, width: 10, height: 5 },
      { row: 0, col: 11, width: 10, height: 5 },
      { row: 6, col: 0, width: 21, height: 5 },
    ];
    const cursor = (row: number, col: number) => (fire(canvas, ev("mousemove", at(row, col))), canvas.style.cursor);
    expect(cursor(2, 10)).toBe("col-resize");
    expect(cursor(2, 9)).toBe("");
    expect(cursor(5, 3)).toBe("row-resize");
    expect(cursor(5, 15)).toBe("row-resize");
    expect(cursor(11, 3)).toBe("");
    expect(cursor(8, 21)).toBe("col-resize");
    wins = undefined;
    expect(cursor(2, 10)).toBe("");
  });
});

describe("attachInput: the wheel", () => {
  const wheel = (deltaY: number, deltaX = 0, deltaMode = 0) => fire(canvas, ev("wheel", { deltaY, deltaX, deltaMode, ...at(1, 1) }));
  const steps = () => take().map((c) => c[2]);

  test("a notch is a step; small deltas add up to three cells' worth a step", () => {
    expect(wheel(100)).toBe(true);
    expect(steps()).toEqual(["down"]);
    for (let i = 0; i < 5; i++) wheel(10);
    expect(steps()).toEqual([]);
    wheel(10);
    expect(steps()).toEqual(["down"]);
    // What's over carries on; a turn the other way starts again.
    wheel(50);
    wheel(-50);
    expect(steps()).toEqual([]);
    wheel(-15);
    expect(steps()).toEqual(["up"]);
  });

  test("lines and pages, and sideways by the cell's width", () => {
    wheel(3, 0, 1);
    wheel(1, 0, 2);
    wheel(0, -30);
    wheel(0, 31);
    expect(steps()).toEqual(["down", "down", "left", "right"]);
    expect(take()).toEqual([]);
  });

  test("at the cell under the pointer", () => {
    fire(canvas, ev("wheel", { deltaY: -100, deltaX: 0, deltaMode: 0, ...at(7, 9), ctrlKey: true }));
    expect(take()).toEqual([["nvim_input_mouse", "wheel", "up", "C", 0, 7, 9]]);
  });
});

describe("attachInput: touch", () => {
  const touch = (type: string, id: number, row: number, col: number, dy = 0) =>
    fire(canvas, ev(type, { pointerType: "touch", pointerId: id, clientX: at(row, col).clientX, clientY: at(row, col).clientY + dy }));

  test("a tap is a click where it lands", () => {
    expect(touch("pointerdown", 1, 3, 4)).toBe(true);
    touch("pointermove", 1, 3, 4, 4);
    touch("pointerup", 1, 3, 4, 4);
    expect(take()).toEqual([
      ["nvim_input_mouse", "left", "press", "", 0, 3, 4],
      ["nvim_input_mouse", "left", "release", "", 0, 3, 4],
    ]);
  });

  test("a drag scrolls a line a cell, and is no click", () => {
    touch("pointerdown", 2, 5, 0);
    touch("pointermove", 2, 7, 0, 1); // two cells and a bit down: the text comes down
    touch("pointermove", 2, 6, 0);
    touch("pointerup", 2, 6, 0);
    expect(take().map((c) => c.slice(1, 3))).toEqual([
      ["wheel", "up"],
      ["wheel", "up"],
      ["wheel", "down"],
    ]);
  });

  test("another finger, a cancel and a mouse's pointer are left alone", () => {
    touch("pointerdown", 3, 1, 1);
    touch("pointerup", 4, 1, 1);
    touch("pointercancel", 3, 1, 1);
    touch("pointerup", 3, 1, 1);
    expect(fire(canvas, ev("pointerdown", { pointerType: "mouse", pointerId: 5, ...at(1, 1) }))).toBe(false);
    expect(take()).toEqual([]);
  });
});
