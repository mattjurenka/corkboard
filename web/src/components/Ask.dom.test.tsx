// A question from Neovim (corkboard.ask) as the store opens it: typed,
// secret or picked, answered by Enter, a click, a number or j/k, cancelled
// by Esc or a press outside, and each reply sent once.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { NvimContext } from "@/nvim/context";
import { store } from "@/store";
import { cleanup, click, fakeNvim, one, press, render, type } from "@/testing/render";
import { Ask } from "./Ask";

afterEach(() => {
  cleanup();
  act(() => store.set({ ask: null }));
});

function ask(q: Partial<NonNullable<ReturnType<typeof store.get>["ask"]>>) {
  const n = fakeNvim();
  const r = render(
    <NvimContext.Provider value={n.nvim}>
      <Ask />
    </NvimContext.Provider>,
  );
  act(() => store.set({ ask: { id: 3, prompt: "Name?", default: "", ...q } }));
  return { ...n, ...r, dialog: r.el.querySelector<HTMLElement>("[role=dialog]")! };
}

describe("Ask", () => {
  test("nothing until asked", () => {
    const { el } = render(
      <NvimContext.Provider value={fakeNvim().nvim}>
        <Ask />
      </NvimContext.Provider>,
    );
    expect(el.innerHTML).toBe("");
  });

  test("a field with the default in it, the caret at its end; Enter answers what's typed, once, and it shuts", () => {
    const { dialog, take, calls } = ask({ default: "draft" });
    expect(dialog.getAttribute("aria-label")).toBe("Name?");
    const field = dialog.querySelector("textarea")!;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("draft");
    expect([field.selectionStart, field.selectionEnd]).toEqual([5, 5]);
    type(field, "final");
    expect(press(field, "Enter").defaultPrevented).toBe(true);
    expect(take()).toEqual([["ask.reply", 3, "final"]]);
    expect(store.get().ask).toBeNull();
    expect(calls.refocus).toBe(1);
  });

  test("Shift+Enter is a new line, and the field grows with them up to eight", () => {
    const { dialog, take } = ask({});
    const field = dialog.querySelector("textarea")!;
    // happy-dom's rows is a string.
    expect(Number(field.rows)).toBe(2);
    expect(press(field, "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    type(field, "1\n2\n3");
    expect(Number(field.rows)).toBe(3);
    type(field, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
    expect(Number(field.rows)).toBe(8);
    expect(take()).toEqual([]);
  });

  test("an Enter that ends a word being composed is the composition's, not the answer", () => {
    const { dialog, take } = ask({});
    const field = dialog.querySelector("textarea")!;
    type(field, "zhong");
    press(field, "Enter", { isComposing: true });
    expect(take()).toEqual([]);
    expect(store.get().ask).not.toBeNull();
    type(field, "中");
    press(field, "Enter");
    expect(take()).toEqual([["ask.reply", 3, "中"]]);
  });

  test("digits and j/k in a typed answer are the answer's", () => {
    const { dialog, take } = ask({});
    const field = dialog.querySelector("textarea")!;
    for (const k of ["1", "j", "k", "Tab"]) expect(press(field, k).defaultPrevented).toBe(false);
    expect(take()).toEqual([]);
  });

  test("Esc, cancel, or a press outside answer none", () => {
    for (const how of ["esc", "cancel", "outside"] as const) {
      const { el, dialog, take, unmount } = ask({});
      if (how === "esc") press(dialog.querySelector("textarea")!, "Escape");
      else if (how === "cancel") click(one(dialog, "button", "esc cancel"));
      else act(() => void el.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      expect({ how, sent: take() }).toEqual({ how, sent: [["ask.reply", 3, null]] });
      unmount();
    }
  });

  test("a press inside isn't outside", () => {
    const { dialog, take } = ask({});
    act(() => void dialog.querySelector("p")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(take()).toEqual([]);
    expect(store.get().ask).not.toBeNull();
  });

  test("⏎ ok answers the field", () => {
    const { dialog, take } = ask({ default: "x" });
    click(one(dialog, "button", "⏎ ok"));
    expect(take()).toEqual([["ask.reply", 3, "x"]]);
  });

  test("a secret is a password field, focused", () => {
    const { dialog, take } = ask({ secret: true });
    const field = dialog.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(document.activeElement).toBe(field);
    expect(dialog.querySelector("textarea")).toBeNull();
    type(field, "hunter2");
    press(field, "Enter");
    expect(take()).toEqual([["ask.reply", 3, "hunter2"]]);
  });

  test("choices: picked by click, by number, or j/k/Tab/arrows and Enter, the list held to its ends", () => {
    const choices = ["red", "green", "blue"];
    let m = ask({ choices });
    expect(document.activeElement).toBe(m.dialog);
    expect([...m.dialog.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1red", "2green", "3blue"]);
    click(m.dialog.querySelectorAll("li")[2]);
    expect(m.take()).toEqual([["ask.reply", 3, 3]]);
    m.unmount();

    m = ask({ choices });
    press(m.dialog, "2");
    expect(m.take()).toEqual([["ask.reply", 3, 2]]);
    m.unmount();

    m = ask({ choices });
    const picked = () => m.dialog.querySelector("li.bg-selection")!.textContent;
    for (const k of ["j", "Tab", "ArrowDown", "j"]) press(m.dialog, k);
    expect(picked()).toBe("3blue");
    press(m.dialog, "k");
    press(m.dialog, "ArrowUp");
    press(m.dialog, "k");
    expect(picked()).toBe("1red");
    press(m.dialog, "ArrowDown");
    // A number past the list, or none, is nothing.
    expect(press(m.dialog, "4").defaultPrevented).toBe(false);
    expect(press(m.dialog, " ").defaultPrevented).toBe(false);
    press(m.dialog, "Enter");
    expect(m.take()).toEqual([["ask.reply", 3, 2]]);
  });

  test("asked again, the last answer's gone and the first choice is picked", () => {
    const m = ask({ choices: ["a", "b"] });
    press(m.dialog, "j");
    act(() => store.set({ ask: { id: 4, prompt: "Again?", default: "", choices: ["a", "b"] } }));
    expect(m.el.querySelector("li.bg-selection")!.textContent).toBe("1a");
    act(() => store.set({ ask: { id: 5, prompt: "Type", default: "d" } }));
    expect(m.el.querySelector("textarea")!.value).toBe("d");
  });
});
