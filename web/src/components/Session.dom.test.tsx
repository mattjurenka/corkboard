// The session picker on the page: its columns as the store opens them,
// stepped through by key and click, and what it hands to corkboard.session.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { NvimContext } from "@/nvim/context";
import { store, type SessionPick } from "@/store";
import { cleanup, click, fakeNvim, one, press, render } from "@/testing/render";
import { Session } from "./Session";

afterEach(() => {
  cleanup();
  act(() => store.set({ session: null }));
});

const PICK: SessionPick = {
  title: "Session",
  items: [
    {
      text: "work",
      items: [
        {
          text: "Claude Code",
          items: [
            { text: "here", detail: "laptop", id: 1 },
            { text: "new dev", detail: "lab · 2 of 4 free", id: 2 },
          ],
        },
        { text: "Codex", items: [{ text: "here", detail: "laptop", id: 3 }] },
      ],
    },
    { text: "home", items: [] },
    { text: "no brain", items: [{ text: "Codex", items: [{ text: "new dev", id: 4 }] }] },
  ],
};

function mount(pick: SessionPick | null = PICK) {
  const n = fakeNvim();
  const r = render(
    <NvimContext.Provider value={n.nvim}>
      <Session />
    </NvimContext.Provider>,
  );
  if (pick) act(() => store.set({ session: pick }));
  const keys = () => r.el.querySelector<HTMLElement>("[tabindex]")!;
  // Each column's rows, the chosen one in brackets, the keys' own doubled.
  const columns = () =>
    [...r.el.querySelectorAll("ul")].map((ul) =>
      [...ul.querySelectorAll("li")].map((li) => {
        const text = li.querySelector("span")?.textContent ?? li.textContent;
        return li.classList.contains("bg-selection") ? `[[${text}]]` : li.getAttribute("aria-selected") === "true" ? `[${text}]` : text;
      }),
    );
  return { ...n, ...r, keys, columns };
}

describe("Session", () => {
  test("nothing until it's opened; opened, a column for each level, on the first of the first, with the keys", () => {
    const { el, keys, columns } = mount(null);
    expect(el.innerHTML).toBe("");
    act(() => store.set({ session: PICK }));
    expect(el.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe("Session");
    expect(columns()).toEqual([["[[work]]", "home", "no brain"], ["Claude Code", "Codex"], ["here", "new dev"]]);
    expect(document.activeElement).toBe(keys());
    expect(one(el, "li", "new devlab · 2 of 4 free")).toBeTruthy();
  });

  test("it opens on the last choice, as far as it's still offered", () => {
    const { columns, unmount } = mount({ ...PICK, last: ["work", "Codex", "here"] });
    expect(columns()).toEqual([["[work]", "home", "no brain"], ["Claude Code", "[Codex]"], ["[[here]]"]]);
    unmount();
    act(() => store.set({ session: null }));
    expect(mount({ ...PICK, last: ["no brain", "Claude Code", "here"] }).columns()).toEqual([["work", "home", "[[no brain]]"], ["Codex"], ["new dev"]]);
  });

  test("j/k and the arrows move in a column, what's right of it following; one that offers nothing can't be entered", () => {
    const { keys, columns, take } = mount();
    expect(press(keys(), "j").defaultPrevented).toBe(true);
    expect(columns()).toEqual([["work", "[[home]]", "no brain"], ["—"], []]);
    for (const k of ["l", "Enter", "Tab", "ArrowRight"]) press(keys(), k);
    expect(columns()[0]).toEqual(["work", "[[home]]", "no brain"]);
    press(keys(), "ArrowDown");
    press(keys(), "n", { ctrlKey: true });
    expect(columns()).toEqual([["work", "home", "[[no brain]]"], ["Codex"], ["new dev"]]);
    press(keys(), "k");
    press(keys(), "ArrowUp");
    press(keys(), "p", { ctrlKey: true });
    expect(columns()[0]).toEqual(["[[work]]", "home", "no brain"]);
    expect(take()).toEqual([]);
  });

  test("l, →, Tab or Enter go right and h, ← or Shift+Tab back; Enter on a leaf runs it in Neovim and shuts", () => {
    const { el, keys, columns, take, calls } = mount();
    press(keys(), "l");
    press(keys(), "j");
    expect(columns()).toEqual([["[work]", "home", "no brain"], ["Claude Code", "[[Codex]]"], ["here"]]);
    press(keys(), "h");
    expect(columns()[0][0]).toBe("[[work]]");
    press(keys(), "ArrowRight");
    press(keys(), "ArrowLeft");
    press(keys(), "Tab");
    expect(press(keys(), "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(columns()[0][0]).toBe("[[work]]");
    press(keys(), "Tab");
    press(keys(), "k");
    press(keys(), "Enter");
    press(keys(), "j");
    expect(columns()).toEqual([["[work]", "home", "no brain"], ["[Claude Code]", "Codex"], ["here", "[[new dev]]"]]);
    expect(take()).toEqual([]);
    press(keys(), "Enter");
    expect(take()).toEqual([["session.run", 2]]);
    expect(store.get().session).toBeNull();
    expect(el.innerHTML).toBe("");
    expect(calls.refocus).toBe(1);
  });

  test("a click chooses there and goes right, or runs a leaf", () => {
    const { el, columns, take } = mount();
    click(one(el, "li", "no brain›"));
    expect(columns()).toEqual([["work", "home", "[no brain]"], ["[[Codex]]"], ["new dev"]]);
    click(one(el, "li", "home›"));
    expect(columns()).toEqual([["work", "[[home]]", "no brain"], ["—"], []]);
    click(one(el, "li", "work›"));
    click(one(el, "li", "Codex›"));
    click(one(el, "li", "herelaptop"));
    expect(take()).toEqual([["session.run", 3]]);
    expect(store.get().session).toBeNull();
  });

  test("Escape, q, the key that opened it, × or a press outside shut it with nothing run", () => {
    for (const shut of [
      (m: ReturnType<typeof mount>) => press(m.keys(), "Escape"),
      (m: ReturnType<typeof mount>) => press(m.keys(), "q"),
      (m: ReturnType<typeof mount>) => press(m.keys(), ".", { ctrlKey: true }),
      (m: ReturnType<typeof mount>) => click(m.el.querySelector("button[title='Close (Esc)']")!),
      (m: ReturnType<typeof mount>) => click(m.el.querySelector("[role=dialog]")!.parentElement!),
    ]) {
      const m = mount();
      shut(m);
      expect(store.get().session).toBeNull();
      expect(m.take()).toEqual([]);
      expect(m.calls.refocus).toBe(1);
      m.unmount();
    }
  });
});
