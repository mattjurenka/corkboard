// The Settings tab's controls, clicked and typed into: what each hands to
// corkboard.settings, and when the keys go back to Neovim.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { blur, byText, cleanup, click, fakeNvim, focus, one, press, render, type } from "@/testing/render";
import { Settings } from "./Settings";

afterEach(cleanup);

const setting = (s: Record<string, unknown>): Record<string, unknown> => ({ label: s.key, value: null, default: null, modified: false, ...s });
const STATE = {
  selected: "editor.font",
  leader: " ",
  palette: ["#000000", undefined, "#ff0000"],
  devices: null,
  sections: [
    {
      title: "Editor",
      items: [
        setting({ key: "editor.font", label: "Font", type: "text", value: "Iosevka", placeholder: "monospace", modified: true }),
        setting({ key: "editor.size", label: "Font size", type: "number", value: 14, min: 8, max: 32, step: 2, unit: "px" }),
        setting({ key: "editor.budget", label: "Budget", type: "number", value: null, unit: "$" }),
        setting({ key: "editor.wrap", label: "Wrap", type: "bool", value: null, default: true }),
        setting({ key: "editor.accent", label: "Accent", type: "color", value: null, theme: "#123456" }),
        setting({
          key: "editor.theme",
          label: "Theme",
          type: "enum",
          value: "b",
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ],
        }),
        setting({
          key: "editor.lang",
          label: "Language",
          type: "enum",
          value: null,
          default: 3,
          options: Array.from({ length: 10 }, (_, i) => ({ value: i, label: `Lang ${i}` })),
        }),
        setting({ key: "editor.ignore", label: "Ignore", type: "list", value: ["node_modules", "dist"] }),
        setting({ key: "keys.save", label: "Save", type: "keys", value: null, default: ["<C-s>", "<leader>w"] }),
      ],
    },
  ],
};

function mount(state: object = STATE, focused = true) {
  const n = fakeNvim();
  const r = render(<Settings state={state as never} win={7} buf={3} focused={focused} nvim={n.nvim} />);
  // What was set, leaving out the selecting a press on its row does first.
  const sets = () => n.take().filter((c) => c[0] !== "settings.select");
  return { ...n, ...r, sets };
}
const rowOf = (el: HTMLElement, label: string) => one(el, "span", label).parentElement!;

describe("Settings", () => {
  test("each section's settings, the selected one marked and bold while focused, a changed one with a reset", () => {
    const { el, rerender, nvim } = mount();
    expect(byText(el, "h2", "Editor")).toHaveLength(1);
    const font = rowOf(el, "Font");
    expect(font.hasAttribute("data-selected")).toBe(true);
    expect(one(el, "span", "Font").className).toContain("font-bold");
    expect(font.querySelector("button[title='Reset (x)']")).not.toBeNull();
    expect(rowOf(el, "Wrap").querySelector("button[title='Reset (x)']")).toBeNull();
    rerender(<Settings state={STATE as never} win={7} buf={3} focused={false} nvim={nvim} />);
    expect(one(el, "span", "Font").className).not.toContain("font-bold");
  });

  test("a press selects its setting in Neovim, once", () => {
    const { el, take } = mount();
    click(rowOf(el, "Wrap"));
    click(rowOf(el, "Font"));
    expect(take()).toEqual([["settings.select", "editor.wrap", 7]]);
  });

  test("reset sets none", () => {
    const { el, take } = mount();
    click(rowOf(el, "Font").querySelector("button[title='Reset (x)']")!);
    expect(take()).toEqual([["settings.set", "editor.font", null]]);
  });

  test("search by section, label, key, or a keybinding's keys as typed or as shown", () => {
    const { el } = mount();
    const search = el.querySelector<HTMLInputElement>("input[placeholder=search]")!;
    type(search, "wrap");
    expect([...el.querySelectorAll("section span.flex-none")].map((s) => s.textContent)).toEqual(["Wrap"]);
    type(search, "editor.lang");
    expect(byText(el, "span", "Language")).toHaveLength(1);
    expect(byText(el, "span", "Wrap")).toHaveLength(0);
    type(search, "<leader>w");
    expect(byText(el, "span", "Save")).toHaveLength(1);
    type(search, "EDITOR");
    expect(el.querySelectorAll("section > div")).toHaveLength(9);
    type(search, "nothing like it");
    expect(el.querySelector("section")).toBeNull();
    expect(byText(el, "p", "—")).toHaveLength(1);
  });

  test("Escape in the search empties it and gives the keys back; Enter only gives them back", () => {
    const { el, calls } = mount();
    const search = el.querySelector<HTMLInputElement>("input[placeholder=search]")!;
    type(search, "font");
    press(search, "Enter");
    expect(search.value).toBe("font");
    expect(calls.refocus).toBe(1);
    press(search, "Escape");
    expect(search.value).toBe("");
    expect(calls.refocus).toBe(2);
    // Not while a word is being composed.
    type(search, "字");
    press(search, "Escape", { isComposing: true });
    press(search, "Enter", { isComposing: true });
    expect(search.value).toBe("字");
    expect(calls.refocus).toBe(2);
  });
});

describe("a text field", () => {
  const field = (el: HTMLElement) => rowOf(el, "Font").querySelector<HTMLInputElement>("input")!;

  test("hands its text over on Enter, and gives the keys back", () => {
    const { el, take, calls } = mount();
    const input = field(el);
    expect(input.value).toBe("Iosevka");
    expect(input.placeholder).toBe("monospace");
    focus(input);
    type(input, "Fira");
    expect(take()).toEqual([]);
    press(input, "Enter");
    expect(take()).toEqual([["settings.set", "editor.font", "Fira"]]);
    expect(calls.refocus).toBe(1);
  });

  test("hands it over when left, and nothing when it's as it was", () => {
    const { el, take } = mount();
    const input = field(el);
    focus(input);
    type(input, "Fira");
    blur(input);
    expect(take()).toEqual([["settings.set", "editor.font", "Fira"]]);
    focus(input);
    type(input, "Iosevka");
    blur(input);
    expect(take()).toEqual([]);
  });

  test("Esc puts it back", () => {
    const { el, take, calls } = mount();
    const input = field(el);
    focus(input);
    type(input, "Fira");
    press(input, "Escape");
    expect(take()).toEqual([]);
    expect(input.value).toBe("Iosevka");
    expect(calls.refocus).toBe(1);
    // And the next edit isn't cancelled by it.
    focus(input);
    type(input, "Mono");
    blur(input);
    expect(take()).toEqual([["settings.set", "editor.font", "Mono"]]);
  });

  test("an Enter or Esc that's a word being composed's (an IME's) is the composition's", () => {
    const { el, take, calls } = mount();
    const input = field(el);
    focus(input);
    type(input, "中");
    press(input, "Enter", { isComposing: true });
    press(input, "Escape", { isComposing: true });
    expect(take()).toEqual([]);
    expect(calls.refocus).toBe(0);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("中");
    press(input, "Enter");
    expect(take()).toEqual([["settings.set", "editor.font", "中"]]);
  });

  test("empty is none", () => {
    const { el, take } = mount();
    const input = field(el);
    focus(input);
    type(input, "");
    blur(input);
    expect(take()).toEqual([["settings.set", "editor.font", null]]);
  });

  test("a new value from Neovim replaces what's shown", () => {
    const { el, rerender, nvim } = mount();
    const next = structuredClone(STATE);
    next.sections[0].items[0].value = "Hack";
    rerender(<Settings state={next as never} win={7} buf={3} focused nvim={nvim} />);
    expect(field(el).value).toBe("Hack");
  });

  test("a press in it is its own, not the row's", () => {
    const { el, take } = mount({ ...STATE, selected: "editor.wrap" });
    act(() => void field(el).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    // The capture on the row still selects it.
    expect(take()).toEqual([["settings.select", "editor.font", 7]]);
  });
});

describe("a number", () => {
  const row = (el: HTMLElement) => rowOf(el, "Font size");

  test("− and + step it, held to its range", () => {
    const { el, sets } = mount();
    click(one(row(el), "button", "+"));
    click(one(row(el), "button", "−"));
    expect(sets()).toEqual([
      ["settings.set", "editor.size", 16],
      ["settings.set", "editor.size", 12],
    ]);
    const top = structuredClone(STATE);
    top.sections[0].items[1].value = 32;
    cleanup();
    const again = mount(top);
    click(one(row(again.el), "button", "+"));
    expect(again.sets()).toEqual([["settings.set", "editor.size", 32]]);
  });

  test("typed, it's rounded to the step and held to the range; not a number is nothing", () => {
    const { el, sets } = mount();
    const input = row(el).querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("14");
    for (const [typed, sent] of [
      ["19", 20],
      ["100", 32],
      ["-4", 8],
      ["abc", undefined],
      ["", null],
    ] as const) {
      focus(input);
      type(input, typed);
      blur(input);
      expect(sets()).toEqual(sent === undefined ? [] : [["settings.set", "editor.size", sent]]);
    }
  });

  test("its unit beside it; dollars before it", () => {
    const { el } = mount();
    expect(byText(row(el), "span", "px")).toHaveLength(1);
    const budget = rowOf(el, "Budget");
    expect(budget.textContent).toMatch(/^Budget−\$\+$/);
    expect(budget.querySelector("input")!.value).toBe("");
  });

  test("with no value and no min, − and + start from 0", () => {
    const { el, sets } = mount();
    click(one(rowOf(el, "Budget"), "button", "+"));
    expect(sets()).toEqual([["settings.set", "editor.budget", 1]]);
  });

  test("the slider shows where it is in its range and sets where it's pressed", () => {
    const { el, sets } = mount();
    const slider = row(el).querySelector<HTMLElement>("span.ml-2ch")!;
    // (14 - 8) / 24 of the way: cell 6 of 24.
    expect(slider.textContent).toBe(`${"━".repeat(6)}●${"─".repeat(17)}`);
    slider.getBoundingClientRect = () => ({ left: 100, width: 240, top: 0, right: 340, bottom: 20, height: 20, x: 100, y: 0 }) as DOMRect;
    slider.setPointerCapture = () => {};
    act(() => void slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 220, pointerId: 1 })));
    // Halfway, 20, and past the end, the max.
    act(() => void slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 999, pointerId: 1 })));
    expect(sets()).toEqual([
      ["settings.set", "editor.size", 20],
      ["settings.set", "editor.size", 32],
    ]);
  });
});

describe("a checkbox", () => {
  test("shows its value or its default, and sets the other", () => {
    const { el, sets } = mount();
    const box = rowOf(el, "Wrap").querySelector<HTMLElement>("[role=checkbox]")!;
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.textContent).toBe("[✓]");
    click(box);
    expect(sets()).toEqual([["settings.set", "editor.wrap", false]]);
  });
});

describe("a choice", () => {
  test("opens its options, the current one marked, and sets the one clicked", () => {
    const { el, sets, calls } = mount();
    const row = rowOf(el, "Theme");
    const button = row.querySelector("button")!;
    expect(button.textContent).toBe("Beta ▾");
    click(button);
    const options = [...row.querySelectorAll("[role=option]")];
    expect(options.map((o) => o.textContent)).toEqual(["Alpha", "●Beta"]);
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    // A short list has no filter.
    expect(row.querySelector("input")).toBeNull();
    click(options[0]);
    expect(sets()).toEqual([["settings.set", "editor.theme", "a"]]);
    expect(row.querySelector("[role=listbox]")).toBeNull();
    expect(calls.refocus).toBe(1);
  });

  test("a long list is filtered as typed, with ↑/↓ and Enter, from its default", () => {
    const { el, sets } = mount();
    const row = rowOf(el, "Language");
    click(row.querySelector("button")!);
    const filter = row.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(filter);
    // At the default, 3; down is 4.
    press(filter, "ArrowDown");
    press(filter, "Enter");
    expect(sets()).toEqual([["settings.set", "editor.lang", 4]]);

    click(row.querySelector("button")!);
    const again = row.querySelector<HTMLInputElement>("input")!;
    expect(again.value).toBe("");
    type(again, "lang 1");
    expect([...row.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["Lang 1"]);
    press(again, "ArrowUp");
    press(again, "Enter");
    expect(sets()).toEqual([["settings.set", "editor.lang", 1]]);

    click(row.querySelector("button")!);
    type(row.querySelector<HTMLInputElement>("input")!, "zzz");
    expect(byText(row, "li", "—")).toHaveLength(1);
    press(row.querySelector<HTMLInputElement>("input")!, "Enter");
    expect(sets()).toEqual([]);
    expect(row.querySelector("[role=listbox]")).toBeNull();
  });

  test("its filter's keys while a word is being composed are the composition's", () => {
    const { el, sets } = mount();
    const row = rowOf(el, "Language");
    click(row.querySelector("button")!);
    const filter = row.querySelector<HTMLInputElement>("input")!;
    for (const k of ["ArrowDown", "Enter", "Escape"]) expect(press(filter, k, { isComposing: true }).defaultPrevented).toBe(false);
    expect(sets()).toEqual([]);
    expect(row.querySelector("li.bg-selection")!.textContent).toBe("●Lang 3");
  });

  test("Esc, or a press outside, shuts it", () => {
    const { el, sets } = mount();
    const row = rowOf(el, "Language");
    click(row.querySelector("button")!);
    press(row.querySelector("input")!, "Escape");
    expect(row.querySelector("[role=listbox]")).toBeNull();
    click(row.querySelector("button")!);
    expect(row.querySelector("[role=listbox]")).not.toBeNull();
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(row.querySelector("[role=listbox]")).toBeNull();
    expect(sets()).toEqual([]);
  });
});

describe("a color", () => {
  const row = (el: HTMLElement) => rowOf(el, "Accent");

  test("with none set, the theme's; the palette's and the theme's set when clicked", () => {
    const { el, sets } = mount();
    const button = row(el).querySelector("button")!;
    expect(button.textContent).toBe("#123456");
    click(button);
    const swatches = [...row(el).querySelectorAll<HTMLElement>("button[title]")];
    expect(swatches.map((b) => b.title)).toEqual(["#000000", "#ff0000"]);
    click(swatches[1]);
    expect(sets()).toEqual([["settings.set", "editor.accent", "#ff0000"]]);
    click(button);
    click(one(row(el), "button", "theme"));
    expect(sets()).toEqual([["settings.set", "editor.accent", null]]);
  });

  test("a hex typed in is taken lower case, anything else isn't", () => {
    const { el, sets } = mount();
    click(row(el).querySelector("button")!);
    const hex = row(el).querySelector<HTMLInputElement>("input:not([type=color])")!;
    focus(hex);
    type(hex, " #ABCDEF ");
    press(hex, "Enter");
    expect(sets()).toEqual([["settings.set", "editor.accent", "#abcdef"]]);
    click(row(el).querySelector("button")!);
    const again = row(el).querySelector<HTMLInputElement>("input:not([type=color])")!;
    for (const bad of ["red", "#abc", "#abcdefg", "javascript:x"]) {
      focus(again);
      type(again, bad);
      blur(again);
    }
    expect(sets()).toEqual([]);
  });

  test("the system's picker sets it as it changes", () => {
    const { el, sets } = mount();
    click(row(el).querySelector("button")!);
    const picker = row(el).querySelector<HTMLInputElement>("input[type=color]")!;
    expect(picker.value).toBe("#123456");
    type(picker, "#00ff00");
    expect(sets()).toEqual([["settings.set", "editor.accent", "#00ff00"]]);
  });
});

describe("a list", () => {
  test("× drops an entry, and the field adds one, trimmed, then empties", () => {
    const { el, sets } = mount();
    const row = rowOf(el, "Ignore");
    click(row.querySelectorAll("button[title=Remove]")[0]);
    expect(sets()).toEqual([["settings.set", "editor.ignore", ["dist"]]]);
    const add = row.querySelector<HTMLInputElement>("input[placeholder='+ add']")!;
    focus(add);
    type(add, "  build ");
    press(add, "Enter");
    expect(sets()).toEqual([["settings.set", "editor.ignore", ["node_modules", "dist", "build"]]]);
    expect(add.value).toBe("");
    // Nothing for nothing.
    focus(add);
    type(add, "   ");
    blur(add);
    expect(sets()).toEqual([]);
  });
});

describe("keybindings", () => {
  const row = (el: HTMLElement) => rowOf(el, "Save");

  test("each key as it's shown, the leader as Space, and × drops one", () => {
    const { el, sets } = mount();
    const keys = [...row(el).querySelectorAll<HTMLElement>("span[title]")];
    expect(keys.map((k) => k.title)).toEqual(["<C-s>", "<leader>w"]);
    click(keys[1].querySelector("button")!);
    expect(sets()).toEqual([["settings.set", "keys.save", ["<C-s>"]]]);
  });

  test("+ listens: the keys pressed one after another are one more, a moment after the last", async () => {
    const { el, sets, calls } = mount();
    const add = row(el).querySelector<HTMLButtonElement>("button[title='Add a key']")!;
    click(add);
    expect(add.textContent).toBe("press keys…");
    expect(document.activeElement).toBe(add);
    const ctrlG = press(add, "g", { code: "KeyG", ctrlKey: true });
    expect(ctrlG.defaultPrevented).toBe(true);
    press(add, "x", { code: "KeyX" });
    // A lone modifier is nothing.
    press(add, "Shift", { shiftKey: true });
    expect(sets()).toEqual([]);
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(sets()).toEqual([["settings.set", "keys.save", ["<C-s>", "<leader>w", "<C-g>x"]]]);
    expect(add.textContent).toBe("+");
    expect(calls.refocus).toBe(1);
  });

  test("Esc gives up; leaving it keeps what was pressed; one it has already is nothing", () => {
    const { el, sets } = mount();
    const add = () => row(el).querySelector<HTMLButtonElement>("button[title='Add a key']")!;
    click(add());
    press(add(), "a", { code: "KeyA" });
    press(add(), "Escape");
    expect(add().textContent).toBe("+");
    expect(sets()).toEqual([]);

    click(add());
    press(add(), "s", { code: "KeyS", ctrlKey: true });
    blur(add());
    expect(sets()).toEqual([]);

    click(add());
    press(add(), "q", { code: "KeyQ" });
    blur(add());
    expect(sets()).toEqual([["settings.set", "keys.save", ["<C-s>", "<leader>w", "q"]]]);
  });

  test("keys not listening are left alone", () => {
    const { el } = mount();
    const add = row(el).querySelector<HTMLButtonElement>("button[title='Add a key']")!;
    expect(press(add, "a").defaultPrevented).toBe(false);
  });
});

describe("devices", () => {
  const devices = {
    url: "https://relay.example/abc",
    leader: "d1",
    forge: false,
    devices: [
      { device: "d1", name: "laptop", seen: 0, me: true, connected: true, leader: true },
      { device: "d2", name: "phone", seen: 0, me: false, connected: false, leader: false },
    ],
  };

  test("the address to copy, forge pages, and each device, its box making it the leader", () => {
    const { el, sets } = mount({ ...STATE, devices });
    expect(byText(el, "h2", "Devices")).toHaveLength(1);
    expect(byText(el, "span", "laptop (this machine)")).toHaveLength(1);
    expect(byText(el, "span", "connected")).toHaveLength(1);
    expect(byText(el, "span", "away")).toHaveLength(1);
    click(one(el, "button", "[copy]"));
    click(rowOf(el, "Forge pages via relay (it sees them)").querySelector("[role=checkbox]")!);
    click(rowOf(el, "phone").querySelector("[role=checkbox]")!);
    expect(sets().filter((c) => c[0] === "settings.device")).toEqual([
      ["settings.device", "devices.url"],
      ["settings.device", "devices.forge"],
      ["settings.device", "devices.d2"],
    ]);
  });

  test("found by search by their names", () => {
    const { el } = mount({ ...STATE, devices });
    type(el.querySelector<HTMLInputElement>("input[placeholder=search]")!, "phone");
    expect(byText(el, "h2", "Devices")).toHaveLength(1);
    expect(byText(el, "h2", "Editor")).toHaveLength(0);
    type(el.querySelector<HTMLInputElement>("input[placeholder=search]")!, "font");
    expect(byText(el, "h2", "Devices")).toHaveLength(0);
  });
});
