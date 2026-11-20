// A hold's form (corkboard.holds) as the store opens it: a new one or one to
// edit, its name checked, the secret typed unseen and sent only when typed,
// a stale save given the hold as it is now, and forgetting the secret.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { NvimContext } from "@/nvim/context";
import { type HoldFields, store } from "@/store";
import { cleanup, click, fakeNvim, one, press, render, settle, type } from "@/testing/render";
import { HoldForm } from "./HoldForm";

afterEach(() => {
  cleanup();
  act(() => store.set({ holdForm: null }));
});

const HOLD: HoldFields = { name: "gh-token", about: "GitHub", where: "pass", secret: "2 days ago", recorded: true, updated: "t1", templates: [] };

function form(hold: HoldFields | null, answer: (code: string, args: unknown[]) => unknown = () => ({ name: "saved" })) {
  const n = fakeNvim();
  const lua = n.nvim.lua;
  n.nvim.lua = async (code, ...args) => (await lua(code, ...args), answer(code, args));
  const r = render(
    <NvimContext.Provider value={n.nvim}>
      <HoldForm />
    </NvimContext.Provider>,
  );
  act(() => store.set({ holdForm: { hold } }));
  const field = (id: string) => r.el.querySelector<HTMLInputElement & HTMLTextAreaElement>(`#hold-${id}`)!;
  const submit = () => r.el.querySelector<HTMLButtonElement>("button[type=submit]")!;
  return { ...n, ...r, field, submit };
}

describe("HoldForm", () => {
  test("a new one: its name focused, made once the name is a label", async () => {
    const { el, field, submit, take, calls } = form(null);
    expect(el.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe("new hold");
    expect(document.activeElement).toBe(field("name"));
    expect(submit().textContent).toBe("⏎ make it");
    expect(submit().disabled).toBe(true);
    type(field("name"), "bad name!");
    expect(field("name").className).toContain("border-destructive");
    expect(submit().disabled).toBe(true);
    type(field("name"), "api.key-1");
    type(field("about"), "for the API");
    type(field("where"), "vault");
    expect(submit().disabled).toBe(false);
    click(submit());
    await settle();
    expect(take()).toEqual([["holds.save", null, { name: "api.key-1", about: "for the API", where: "vault" }]]);
    expect(store.get().holdForm).toBeNull();
    expect(calls.refocus).toBe(1);
  });

  test("one to edit: its fields, the secret never shown, only sent when typed", async () => {
    const { el, field, submit, take } = form(HOLD);
    expect(el.querySelector("h2")!.textContent).toBe("edit gh-token");
    expect([field("name").value, field("about").value, field("where").value, field("secret").value]).toEqual(["gh-token", "GitHub", "pass", ""]);
    expect(field("secret").type).toBe("password");
    expect(field("secret").placeholder).toBe("••••••••");
    expect(el.textContent).toContain("set 2 days ago");
    expect(submit().textContent).toBe("⏎ save");
    type(field("secret"), "s3cret");
    // Ctrl+Enter saves from anywhere in it.
    press(field("about"), "Enter", { ctrlKey: true });
    await settle();
    expect(take()).toEqual([["holds.save", HOLD, { name: "gh-token", about: "GitHub", where: "pass", secret: "s3cret" }]]);
  });

  test("one a template holds keeps its name, and opens at what it's for", () => {
    const { el, field } = form({ ...HOLD, templates: ["devshell"], recorded: false });
    expect(field("name").readOnly).toBe(true);
    expect(el.textContent).toContain("nix");
    expect(el.querySelector("h2")!.textContent).toBe("edit gh-token no record");
    expect(document.activeElement).toBe(field("about"));
  });

  test("a stale save: the hold as it is now, what was typed for the secret kept, and why", async () => {
    const now = { ...HOLD, about: "changed elsewhere", updated: "t2" };
    const { el, field, take } = form(HOLD, () => ({ stale: now, problem: "it changed while you had it open" }));
    type(field("about"), "mine");
    type(field("secret"), "kept");
    press(field("about"), "Enter", { ctrlKey: true });
    await settle();
    take();
    expect(field("about").value).toBe("changed elsewhere");
    expect(field("secret").value).toBe("kept");
    expect(el.textContent).toContain("it changed while you had it open");
    expect(store.get().holdForm).not.toBeNull();
  });

  test("Neovim's problem, or none at all, is said and the form stays", async () => {
    for (const [answer, said] of [
      [{ problem: "no keystore" }, "no keystore"],
      [undefined, "couldn't save it"],
    ] as const) {
      const { el, submit, unmount } = form(HOLD, () => answer);
      click(submit());
      await settle();
      expect(el.textContent).toContain(said);
      expect(store.get().holdForm).not.toBeNull();
      unmount();
    }
  });

  test("forget: at once, with the hold as it is after", async () => {
    const after = { ...HOLD, secret: null, updated: "t3" };
    const { el, take } = form(HOLD, () => ({ hold: after }));
    click(one(el, "button", "forget"));
    await settle();
    expect(take()).toEqual([["holds.forget_now", "gh-token", "t1"]]);
    expect(el.textContent).not.toContain("set 2 days ago");
    expect(el.querySelector<HTMLInputElement>("#hold-secret")!.placeholder).toBe("");
  });

  test("Esc and cancel shut it, saving nothing", () => {
    for (const how of ["esc", "cancel"]) {
      const { el, field, take, unmount } = form(HOLD);
      if (how === "esc") press(field("where"), "Escape");
      else click(one(el, "button", "esc cancel"));
      expect(store.get().holdForm).toBeNull();
      expect(take()).toEqual([]);
      unmount();
    }
  });
});
