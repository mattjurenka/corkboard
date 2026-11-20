// The palettes on the page: the frame (shut by its ×, or a press outside
// it), the tool picker and Open project, typed into and stepped through as
// the store opens them.
import "@/testing/dom";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { NvimContext } from "@/nvim/context";
import { store } from "@/store";
import { byText, cleanup, click, fakeNvim, one, press, render, settle, type } from "@/testing/render";
import { Palette } from "./Palette";
import { Projects } from "./Projects";
import { Tools } from "./Tools";

afterEach(() => {
  cleanup();
  act(() => store.set({ tools: null, projects: null, windows: [] }));
});

describe("Palette", () => {
  test("a dialog with its title; × or a press outside closes it, a press inside doesn't", () => {
    let closed = 0;
    const { el } = render(
      <Palette title="Pick" onClose={() => closed++}>
        <p>inside</p>
      </Palette>,
    );
    const dialog = el.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Pick");
    click(one(el, "p", "inside"));
    expect(closed).toBe(0);
    click(dialog.querySelector("button[title='Close (Esc)']")!);
    expect(closed).toBe(1);
    act(() => void dialog.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(closed).toBe(2);
  });
});

function mount(ui: React.ReactNode, answer?: (code: string, arg: unknown) => unknown) {
  const n = fakeNvim();
  if (answer) {
    const lua = n.nvim.lua;
    n.nvim.lua = async (code, ...args) => (await lua(code, ...args), answer(code, args[0]));
  }
  return { ...n, ...render(<NvimContext.Provider value={n.nvim}>{ui}</NvimContext.Provider>) };
}
const rows = (el: HTMLElement) => [...el.querySelectorAll("li")].map((li) => li.textContent);
const picked = (el: HTMLElement) => el.querySelector("li.bg-selection")?.textContent;

describe("Tools", () => {
  const TOOLS = [
    { text: "Find files", hint: "<C-f>" },
    { text: "Board", hint: "<leader>b" },
    { text: "Git", hint: "<C-S-g>" },
    { text: "Reload", hint: "F5" },
    { text: "Usage", hint: "" },
    { text: "Cards", hint: "<A-c>", off: true },
  ];
  const open = () => act(() => store.set({ tools: { leader: "Space", tools: TOOLS } }));

  test("nothing until it's opened; opened, every tool with its keys, and the search has the keys", () => {
    const { el } = mount(<Tools />);
    expect(el.innerHTML).toBe("");
    open();
    expect(rows(el)).toEqual(["Find filesCtrlF", "BoardSpaceB", "GitCtrlShiftG", "ReloadF5", "Usage", "CardsAltC"]);
    expect(document.activeElement).toBe(el.querySelector("input")!);
    expect(picked(el)).toBe("Find filesCtrlF");
    expect(el.querySelector("li[aria-disabled=true]")!.textContent).toBe("CardsAltC");
  });

  test("the search filters, the first match picked; nothing matching says so", () => {
    const { el } = mount(<Tools />);
    open();
    const search = el.querySelector("input")!;
    press(search, "ArrowDown");
    type(search, "ga");
    expect(rows(el)).toEqual(["No tools match"]);
    expect(picked(el)).toBeUndefined();
    type(search, "g");
    expect(rows(el)).toEqual(["GitCtrlShiftG", "Usage"]);
    expect(picked(el)).toBe("GitCtrlShiftG");
  });

  test("↓, Enter: that one runs in Neovim, by its place in the whole list, and the picker shuts", () => {
    const { el, take, calls } = mount(<Tools />);
    open();
    const search = el.querySelector("input")!;
    type(search, "re");
    press(search, "ArrowDown");
    expect(press(search, "Enter").defaultPrevented).toBe(true);
    expect(take()).toEqual([["picker.run", 4]]);
    expect(store.get().tools).toBeNull();
    expect(el.innerHTML).toBe("");
    expect(calls.refocus).toBe(1);
  });

  test("a click runs it; one that needs a project isn't run, by click or Enter", () => {
    const { el, take } = mount(<Tools />);
    open();
    click(one(el, "li", "CardsAltC"));
    type(el.querySelector("input")!, "cards");
    press(el.querySelector("input")!, "Enter");
    expect(take()).toEqual([]);
    expect(store.get().tools).not.toBeNull();
    type(el.querySelector("input")!, "");
    click(one(el, "li", "BoardSpaceB"));
    expect(take()).toEqual([["picker.run", 2]]);
  });

  test("Escape, or the keys that opened it, shut it with nothing run", () => {
    for (const [key, init] of [
      ["Escape", {}],
      [" ", { ctrlKey: true }],
      [" ", { altKey: true }],
      ["P", { ctrlKey: true, shiftKey: true, code: "KeyP" }],
      ["P", { metaKey: true, shiftKey: true, code: "KeyP" }],
    ] as const) {
      const { el, take, unmount } = mount(<Tools />);
      open();
      press(el.querySelector("input")!, key, init);
      expect({ key, init, open: store.get().tools }).toEqual({ key, init, open: null });
      expect(take()).toEqual([]);
      unmount();
    }
  });

  test("opened again, the search is empty and the first picked", () => {
    const { el } = mount(<Tools />);
    open();
    type(el.querySelector("input")!, "git");
    act(() => store.set({ tools: null }));
    open();
    expect(el.querySelector("input")!.value).toBe("");
    expect(rows(el)).toHaveLength(6);
  });

  test("the pointer picks what it's over", () => {
    const { el } = mount(<Tools />);
    open();
    act(() => void one(el, "li", "ReloadF5").dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    expect(picked(el)).toBe("ReloadF5");
  });
});

describe("Projects", () => {
  const LISTED = {
    dir: "/home/me/src/",
    projects: [
      { key: "a", name: "alpha", root: "r1", path: "/home/me/src/alpha", where: "here" },
      { key: "b", name: "beta", root: "r2", remote: "git@github.com:me/beta.git" },
      { key: "c", name: "gamma", root: "r3", path: "/home/me/src/gamma" },
    ],
  };
  let answer: (code: string, arg: unknown) => unknown;
  beforeEach(() => {
    answer = (code) => (code.includes("account_projects") ? LISTED : { opened: true });
  });
  const go = (here = false, naming = false) => {
    const m = mount(<Projects />, (code, arg) => answer(code, arg));
    act(() => store.set({ projects: { here, naming } }));
    return m;
  };

  test("the account's projects once Neovim lists them, each with where it is, and a new one under them", async () => {
    const { el } = go();
    // Until then, a spinner where they'll be.
    expect(rows(el)).toHaveLength(2);
    expect(rows(el)[1]).toBe("New project");
    await settle();
    expect(rows(el)).toEqual(["alphahere", "betagithub.com/me/beta", "gamma", "New project"]);
    expect(document.activeElement).toBe(el.querySelector("input")!);
  });

  test("the search filters by name, where and remote; what's typed names the new one, under the account's folder", async () => {
    const { el } = go();
    await settle();
    const search = el.querySelector("input")!;
    type(search, "github");
    expect(rows(el)).toEqual(["betagithub.com/me/beta", "New project github/home/me/src/github"]);
    type(search, "zzz");
    expect(rows(el)).toEqual(["No projects match", "New project zzz/home/me/src/zzz"]);
    type(search, "~/x/new");
    expect(rows(el).at(-1)).toBe("New project new~/x/new");
  });

  test("Enter opens the one picked in Neovim and shuts", async () => {
    const { el, take, calls } = go();
    await settle();
    take();
    const search = el.querySelector("input")!;
    press(search, "ArrowDown");
    press(search, "Enter");
    await settle();
    expect(take()).toEqual([["picker.open_project", LISTED.projects[1]]]);
    expect(store.get().projects).toBeNull();
    expect(calls.refocus).toBe(1);
  });

  test("one with a window already goes to that window", async () => {
    const { el, take, calls } = go();
    act(() => store.set({ windows: ["/home/me/src/gamma"] }));
    await settle();
    take();
    click(one(el, "li", "gamma"));
    expect(take()).toEqual([]);
    expect(calls.notify).toEqual([["corkboard.window", "/home/me/src/gamma"]]);
    expect(store.get().projects).toBeNull();
  });

  test("New project with nothing typed asks for a name; Escape goes back to the list", async () => {
    const { el, take } = go();
    await settle();
    take();
    click(one(el, "li", "New project"));
    expect(rows(el)).toEqual(["New project"]);
    const search = el.querySelector("input")!;
    expect(search.placeholder).toBe("Name or path");
    type(search, "fresh");
    press(search, "Escape");
    expect(search.value).toBe("");
    expect(rows(el)).toHaveLength(4);
    expect(store.get().projects).not.toBeNull();
    press(search, "Escape");
    expect(store.get().projects).toBeNull();
    expect(take()).toEqual([]);
  });

  test("named, Enter makes it", async () => {
    const { el, take } = go(false, true);
    await settle();
    take();
    type(el.querySelector("input")!, " fresh ");
    press(el.querySelector("input")!, "Enter");
    await settle();
    expect(take()).toEqual([["picker.new_project", "fresh"]]);
  });

  test("Neovim's error is shown and the palette stays", async () => {
    const { el } = go();
    await settle();
    answer = () => ({ error: "clone failed" });
    press(el.querySelector("input")!, "Enter");
    await settle();
    expect(byText(el, "div", "clone failed")).toHaveLength(1);
    expect(store.get().projects).not.toBeNull();
    expect(el.querySelector("input")!.disabled).toBe(false);
  });

  test("a list Neovim doesn't answer says so", async () => {
    answer = () => undefined;
    const { el } = go();
    await settle();
    expect(rows(el)).toEqual(["Neovim didn't answer", "New project"]);
  });

  test("with a project open here, a window of its own, sent to the project's path, opened before Neovim is asked", async () => {
    const opened: { href: string; closed: boolean }[] = [];
    const open = spyOn(window, "open").mockImplementation(() => {
      const w = { location: { href: "about:blank" }, closed: false, close: () => void (w.closed = true) };
      opened.push(w as never);
      return w as never;
    });
    try {
      answer = (code) => (code.includes("account_projects") ? LISTED : { opened: true, path: "/home/me/src/alpha" });
      const { el } = go(true);
      await settle();
      press(el.querySelector("input")!, "Enter");
      await settle();
      expect(opened).toHaveLength(1);
      const url = new URL((opened[0] as unknown as { location: { href: string } }).location.href);
      expect(url.searchParams.get("cwd")).toBe("/home/me/src/alpha");
      expect(url.origin).toBe(location.origin);

      // Blocked: said, and Neovim never asked.
      act(() => store.set({ projects: { here: true } }));
      await settle();
      open.mockImplementation(() => null);
      answer = () => {
        throw new Error("asked");
      };
      press(el.querySelector("input")!, "Enter");
      await settle();
      expect(byText(el, "div", "The browser blocked the new window")).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });
});
