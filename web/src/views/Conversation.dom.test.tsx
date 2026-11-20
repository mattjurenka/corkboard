// A session's conversation as the page draws it (corkboard.conversation's
// state): the turns, the tools and their results, questions, and the
// composer, with what each click and key hands Neovim; and Claude's turns
// put through DOMPurify with nothing that runs coming out.
import "@/testing/dom";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { byText, cleanup, click, fakeNvim, focus, one, press, render, type } from "@/testing/render";
import { executable, PIECES, VECTORS } from "@/testing/xss";
import { fuzz } from "../../../lib/testing/fuzz";
import { Conversation } from "./Conversation";

afterEach(cleanup);

type State = Parameters<typeof Conversation>[0]["state"];
function mount(state: State) {
  const n = fakeNvim();
  const r = render(<Conversation state={state} win={5} buf={8} focused nvim={n.nvim} />);
  // The calls to corkboard.conversation, leaving out making its window current.
  const said = () => n.take().filter((c) => typeof c[0] === "string" && c[0].startsWith("conversation."));
  return { ...n, ...r, said, again: (s: State) => r.rerender(<Conversation state={s} win={5} buf={8} focused nvim={n.nvim} />) };
}
const composer = (el: HTMLElement) => el.querySelector("textarea")!;

describe("Conversation", () => {
  test("its name, where it runs and its state along the top", () => {
    const { el, again } = mount({ name: "fix the build", where: { vm: "vm1", host: "laptop", dir: "~/src/x" }, state: "working" });
    const header = el.querySelector("header")!;
    expect(header.textContent).toBe("fix the buildvm1 · laptop · ~/src/xworking");
    again({ name: "fix the build", state: "working", ended: true });
    expect(el.querySelector("header")!.textContent).toBe("fix the buildended");
  });

  test("your turns as text, Claude's as markdown, notes, and working while it works", () => {
    const { el } = mount({
      state: "working",
      items: [
        { kind: "you", id: "1", text: "make it **bold**" },
        { kind: "claude", id: "2", text: "Done: **bold** and `code`" },
        { kind: "note", id: "3", text: "compacted" },
        { kind: "note", id: "4", text: "failed", error: true },
      ],
      live: "Still *going*",
    });
    expect(byText(el, "span", "make it **bold**")).toHaveLength(1);
    const md = el.querySelectorAll(".markdown-body");
    expect(md[0].innerHTML).toBe("<p>Done: <strong>bold</strong> and <code>code</code></p>\n");
    expect(md[1].innerHTML).toBe("<p>Still <em>going</em></p>\n");
    expect(one(el, "div", "failed").className).toContain("text-destructive");
    expect(byText(el, "div", "✻ working…")).toHaveLength(1);
  });

  test("a tool: its first line of detail and two of its result; a click opens all of it, and again shuts it", () => {
    const { el } = mount({
      items: [{ kind: "tool", id: "t1", tool: "Bash", detail: "ls\n-la", call: "c1" }],
      results: { c1: { call: "c1", text: "a\nb\nc" } },
    });
    const tool = el.querySelector<HTMLElement>(".cursor-pointer")!;
    expect(tool.textContent).toBe("●Bash ls  └a\nb");
    click(tool);
    expect(tool.textContent).toBe("●Bash ls\n-la  └a\nb\nc");
    click(tool);
    expect(tool.textContent).toBe("●Bash ls  └a\nb");
  });

  test("a tool still running pulses; an error is red; an agent's result opens as markdown", () => {
    const { el } = mount({
      items: [
        { kind: "tool", id: "t1", tool: "Read", detail: "x", call: "c1" },
        { kind: "tool", id: "t2", tool: "Edit", detail: "y", call: "c2" },
        { kind: "tool", id: "t3", tool: "Agent", detail: "z", call: "c3" },
      ],
      results: { c2: { call: "c2", text: "nope", error: true }, c3: { call: "c3", text: "**found**" } },
    });
    const [read, edit, agent] = el.querySelectorAll<HTMLElement>(".cursor-pointer");
    expect(read.querySelector("span")!.className).toContain("animate-pulse-dot");
    expect(edit.querySelector("span")!.className).toContain("text-destructive");
    click(agent);
    expect(agent.querySelector(".markdown-body")!.innerHTML).toBe("<p><strong>found</strong></p>\n");
  });

  test("results Neovim sends as an empty list, and calls and ids named like the prototype's, are only themselves", () => {
    const { el } = mount({
      items: [
        { kind: "tool", id: "__proto__", tool: "Bash", detail: "x", call: "constructor" },
        { kind: "tool", id: "toString", tool: "Bash", detail: "y", call: "toString" },
      ],
      results: [],
    });
    const tools = [...el.querySelectorAll<HTMLElement>(".cursor-pointer")];
    // No result: still running, and nothing under it.
    for (const t of tools) expect(t.querySelector("span")!.className).toContain("animate-pulse-dot");
    expect(el.textContent).not.toContain("└");
    click(tools[0]);
    expect(tools[0].querySelector(".whitespace-pre-wrap")).not.toBeNull();
    expect(tools[1].querySelector(".whitespace-pre-wrap")).toBeNull();
  });

  test("a question: its options, each a pick by its number; several picked, then sent", () => {
    const { el, said } = mount({
      questions: [
        { header: "Which", question: "Pick one", options: [{ label: "A", description: "the first" }, { label: "B", description: "B" }] },
        { header: "And", question: "Pick some", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
      ],
      ask: { step: 1, picks: [] },
    });
    const box = el.querySelector("section")!;
    expect(box.querySelector("h2")!.textContent).toBe("Which1/2");
    // A description that says no more than the label isn't shown.
    expect([...box.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1Athe first", "2B"]);
    click(box.querySelectorAll("li")[1]);
    expect(said()).toEqual([["conversation.pick", 8, 2]]);
    // Single choice: no send.
    expect(byText(box, "button", "⏎ next")).toHaveLength(0);
  });

  test("several to pick: boxes, the picked bold, and ⏎ to go on or send", () => {
    const state: State = {
      questions: [{ header: "Q1", options: [{ label: "x" }] }, { header: "Q2", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] }],
      ask: { step: 2, picks: [1] },
    };
    const { el, said, again } = mount(state);
    const box = el.querySelector("section")!;
    expect([...box.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["[ ]X", "[x]Y"]);
    expect(box.querySelectorAll("li")[1].className).toContain("bg-selection");
    click(one(box, "button", "⏎ send"));
    expect(said()).toEqual([["conversation.submit", 8, ""]]);
    // With other text typed, on a step before the last: next.
    again({ ...state, ask: { step: 1, picks: [], other: "my own" } });
    expect(byText(el, "span", "my own")).toHaveLength(1);
    expect(byText(el, "button", "⏎ next")).toHaveLength(1);
  });

  test("answers it offers, each a pick; the status, and reconnect once ended", () => {
    const { el, said } = mount({ answers: ["yes", "no"], status: "lost the session", ended: true });
    click(one(el, "button", "2 no"));
    click(one(el, "button", "R reconnect"));
    expect(said()).toEqual([
      ["conversation.pick", 8, 2],
      ["conversation.refollow", 8],
    ]);
  });

  test("a link in Claude's text opens in a tab of the browser's, never in place of the page", () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    try {
      const { el } = mount({ items: [{ kind: "claude", id: "1", text: "[a](https://a.example) [b](/local) [c](#x)" }] });
      for (const a of el.querySelectorAll(".markdown-body a")) {
        const e = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => void a.dispatchEvent(e));
        expect(e.defaultPrevented).toBe(true);
      }
      expect(open.mock.calls).toEqual([["https://a.example", "_blank", "noopener"]]);
    } finally {
      open.mockRestore();
    }
  });

  test("a press in the transcript makes its window current; let go with nothing selected, the keys go back", () => {
    const { el, take, calls } = mount({ items: [{ kind: "you", id: "1", text: "hi" }] });
    const transcript = el.querySelector<HTMLElement>("[tabindex='-1']")!;
    act(() => void transcript.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(take()).toEqual([["local w = ... if vim.api.nvim_win_is_valid(w) then vim.api.nvim_set_current_win(w) end", 5]]);
    act(() => void transcript.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(calls.refocus).toBe(1);
    // A key there, but a copy, goes back too.
    press(transcript, "c", { ctrlKey: true });
    expect(calls.refocus).toBe(1);
    press(transcript, "j");
    expect(calls.refocus).toBe(2);
  });
});

describe("the composer", () => {
  test("Enter sends what's typed and empties it; Shift+Enter is a new line", () => {
    const { el, said } = mount({});
    const field = composer(el);
    focus(field);
    type(field, "hello");
    expect(press(field, "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(said()).toEqual([]);
    expect(press(field, "Enter").defaultPrevented).toBe(true);
    expect(said()).toEqual([["conversation.submit", 8, "hello"]]);
    expect(field.value).toBe("");
  });

  test("not while a word is being composed", () => {
    const { el, said } = mount({});
    type(composer(el), "ni");
    press(composer(el), "Enter", { isComposing: true });
    expect(said()).toEqual([]);
  });

  test("send and stop by click: ⏎ send with text, ^C stop while it works with none", () => {
    const { el, said } = mount({ state: "working" });
    click(one(el, "button", "^C stop"));
    type(composer(el), "more");
    expect(byText(el, "button", "^C stop")).toHaveLength(0);
    click(one(el, "button", "⏎ send"));
    expect(said()).toEqual([
      ["conversation.interrupt", 8],
      ["conversation.submit", 8, "more"],
    ]);
    // Blank is no send button.
    type(composer(el), "   ");
    expect(byText(el, "button", "⏎ send")).toHaveLength(0);
  });

  test("Ctrl+C with nothing typed stops it; with text, it's the field's", () => {
    const { el, said } = mount({});
    expect(press(composer(el), "c", { code: "KeyC", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(said()).toEqual([["conversation.interrupt", 8]]);
    type(composer(el), "x");
    expect(press(composer(el), "c", { code: "KeyC", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(said()).toEqual([]);
  });

  test("Escape gives the keys back", () => {
    const { el, calls } = mount({});
    expect(press(composer(el), "Escape").defaultPrevented).toBe(true);
    expect(calls.refocus).toBe(1);
  });

  test("Neovim's chords go to Neovim from here; the field's editing chords and typing stay in it", () => {
    const { el, calls } = mount({});
    const field = composer(el);
    // Alt+l, a window to the right; Ctrl+t, Neovim's.
    expect(press(field, "l", { code: "KeyL", altKey: true }).defaultPrevented).toBe(true);
    expect(press(field, "t", { code: "KeyT", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(calls.notify).toEqual([
      ["nvim_input", "<A-l>"],
      ["nvim_input", "<C-t>"],
    ]);
    expect(calls.refocus).toBe(2);
    for (const [key, init] of [
      ["a", { code: "KeyA", ctrlKey: true }],
      ["v", { code: "KeyV", ctrlKey: true }],
      ["Z", { code: "KeyZ", ctrlKey: true, shiftKey: true }],
      ["Backspace", { ctrlKey: true }],
      ["ArrowLeft", { ctrlKey: true }],
      ["x", { code: "KeyX" }],
      ["Enter", { shiftKey: true }],
    ] as const)
      expect({ key, init, taken: press(field, key, init).defaultPrevented }).toEqual({ key, init, taken: false });
    expect(calls.notify).toHaveLength(2);
  });

  test("i, a or o in the window bumps focus into it, but not its first state", () => {
    const { el, again } = mount({ focus: 3 });
    expect(document.activeElement).not.toBe(composer(el));
    again({ focus: 4 });
    expect(document.activeElement).toBe(composer(el));
  });

  test("a press in it makes its window current and is its own", () => {
    const { el, take } = mount({});
    act(() => void composer(el).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    // Once, from the field: the transcript's own press handler isn't reached.
    expect(take()).toHaveLength(1);
  });
});

describe("Claude's turns through DOMPurify", () => {
  const drawn = (text: string, where: "claude" | "live" | "agent") => {
    const state: State =
      where === "claude"
        ? { items: [{ kind: "claude", id: "1", text }] }
        : where === "live"
          ? { live: text }
          : { items: [{ kind: "tool", id: "t", tool: "Task", detail: "", call: "c" }], results: { c: { call: "c", text } } };
    const m = mount(state);
    if (where === "agent") click(m.el.querySelector(".cursor-pointer")!);
    return m;
  };

  test("nothing that runs comes out of any of the markdown that tries, said, being said, or an agent's result", () => {
    for (const where of ["claude", "live", "agent"] as const)
      for (const text of VECTORS) {
        const { el, unmount } = drawn(text, where);
        const md = el.querySelector(".markdown-body");
        expect({ where, text, found: md ? executable(md) : [] }).toEqual({ where, text, found: [] });
        unmount();
      }
  });
});

fuzz(
  "Claude's turns never run anything",
  (g) => {
    let text = "";
    for (let n = g.size(40); n > 0; n--) text += g.bool(0.8) ? g.pick(PIECES) : g.string(8);
    const { el, unmount } = mount({ items: [{ kind: "claude", id: "1", text }] });
    const found = executable(el.querySelector(".markdown-body")!);
    unmount();
    if (found.length) throw new Error(`${JSON.stringify(text)}: ${found.join("; ")}`);
  },
  { runs: 300 },
);
