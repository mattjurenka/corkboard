// A card's review (corkboard.review's state) as the page draws it: the
// branch and its counts, what blocks a merge, the reviewer's and the
// agent's markdown, the files opened to their diffs and a diff line to its
// file, the folds; and the markdown, under md() and no sanitiser, with
// nothing that runs coming out.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { byText, cleanup, click, fakeNvim, one, render } from "@/testing/render";
import { executable, VECTORS } from "@/testing/xss";
import { Review } from "./Review";

afterEach(cleanup);

type State = Parameters<typeof Review>[0]["state"];
const STATE: State = {
  id: "c-12",
  title: "Fix the thing",
  branch: "agent/c-12/work",
  main: "main",
  dir: "/w/c-12",
  description: "Do **it**",
  log: [{ time: "10:00", who: "claude", text: "started" }],
  summary: { time: "11:00", text: "Did *it*", verified: "ran the tests" },
  reviewer: { risk: "low", summary: "Fine", problems: ["one thing"] },
  files: [
    {
      path: "src/a.ts",
      status: "M",
      added: 2,
      removed: 1,
      lines: [
        ["@", "@@ -1,3 +1,4 @@ function a", null],
        [" ", "const x = 1;", 1],
        ["-", "old", null],
        ["+", "new", 2],
      ],
    },
    { path: "img.png", status: "A", added: 0, removed: 0, binary: true, lines: [] },
  ],
  commits: [{ sha: "abc1234", subject: "fix" }],
};

function mount(state: State = STATE) {
  const n = fakeNvim();
  return { ...n, ...render(<Review state={state} win={2} buf={3} focused nvim={n.nvim} />) };
}

describe("Review", () => {
  test("the card, its branch into main, and what it adds up to", () => {
    const { el } = mount();
    expect(el.querySelector("header")!.textContent).toContain("c-12 Fix the thing");
    expect(el.querySelector("header")!.textContent).toContain("agent/c-12/work → main · 1 commit · 2 files +2 −1");
    expect(one(el, "button", "A approve and merge")).toBeTruthy();
    expect(mount({ ...STATE, branch: undefined }).el.textContent).toContain("no branch");
  });

  test("approve, send back and close are Neovim's actions", () => {
    const { el, take } = mount();
    click(one(el, "button", "A approve and merge"));
    click(one(el, "button", "S send back"));
    click(one(el, "button", "q close"));
    expect(take()).toEqual([
      ["review.action", "c-12", "approve"],
      ["review.action", "c-12", "send_back"],
      ["review.action", "c-12", "close"],
    ]);
  });

  test("what stands in a merge's way, the approve key dimmed for it", () => {
    const { el } = mount({ ...STATE, conflicts: ["src/a.ts"], dirty: ["x/y.md"], uncommitted: ["1", "2"], gone: true });
    for (const line of ["✗ conflicts with main: a.ts", "✗ uncommitted in main: y.md", "✗ uncommitted in the worktree: 2 files", "· worktree removed; the branch is still there"])
      expect(byText(el, "div", line)).toHaveLength(1);
    expect(one(el, "kbd", "A").className).toContain("text-muted-foreground");
  });

  test("the reviewer's and the summary's markdown; the summary's verification and the log folded", () => {
    const { el } = mount();
    const md = [...el.querySelectorAll(".markdown-body")].map((a) => a.innerHTML.trim());
    expect(md).toEqual(["<p>Fine</p>", "<p>Did <em>it</em></p>"]);
    expect(byText(el, "div", "✗ one thing")).toHaveLength(1);
    expect(one(el, "span", "low risk").className).toContain("text-working");
    click(one(el, "button", "▸ verified"));
    expect(el.textContent).toContain("ran the tests");
    // What was asked is folded while there's a summary; the full log too.
    click(one(el, "button", "▸ what was asked"));
    expect(el.innerHTML).toContain("Do <strong>it</strong>");
    click(one(el, "button", "▸ full log 1"));
    expect(el.textContent).toContain("10:00 · claude");
  });

  test("with no summary, what was asked is open", () => {
    const { el } = mount({ ...STATE, summary: undefined });
    expect(byText(el, "button", "▾ what was asked")).toHaveLength(1);
  });

  test("a file opens to its diff, and a line opens the file there; a removed line at its hunk's start", () => {
    const { el, take } = mount();
    click(one(el, "span", "src/a.ts").parentElement!);
    const lines = [...el.querySelectorAll<HTMLElement>(".border-l > div")];
    expect(lines.map((l) => l.textContent)).toEqual(["function a", "1const x = 1;", "-old", "2+new"]);
    click(lines[3]);
    click(lines[2]);
    expect(take()).toEqual([
      ["review.open_file", "/w/c-12/src/a.ts", 2],
      ["review.open_file", "/w/c-12/src/a.ts", 1],
    ]);
    click(one(el, "span", "img.png").parentElement!);
    expect(byText(el, "div", "binary")).toHaveLength(1);
    // Shut again.
    click(one(el, "span", "src/a.ts").parentElement!);
    expect(el.querySelectorAll(".border-l")).toHaveLength(0);
  });

  test("a file named like the prototype's opens only itself", () => {
    const files = ["__proto__", "constructor"].map((path) => ({ ...STATE.files[0], path }));
    const { el } = mount({ ...STATE, files });
    expect([...el.querySelectorAll("button.text-left")].map((b) => b.firstElementChild!.textContent)).toEqual(["▸", "▸"]);
    click(one(el, "span", "__proto__").parentElement!);
    expect([...el.querySelectorAll("button.text-left")].map((b) => b.firstElementChild!.textContent)).toEqual(["▾", "▸"]);
  });

  test("with no worktree, a diff line opens nothing", () => {
    const { el, take } = mount({ ...STATE, dir: undefined });
    click(one(el, "span", "src/a.ts").parentElement!);
    click(el.querySelectorAll<HTMLElement>(".border-l > div")[1]);
    expect(take()).toEqual([]);
  });

  test("none of the markdown that tries runs, wherever it's put", () => {
    for (const text of VECTORS) {
      const { el, unmount } = mount({
        ...STATE,
        description: text,
        summary: undefined,
        reviewer: { summary: text },
        log: [],
        after: [{ text }],
      });
      expect({ text, found: executable(el) }).toEqual({ text, found: [] });
      unmount();
    }
  });
});
