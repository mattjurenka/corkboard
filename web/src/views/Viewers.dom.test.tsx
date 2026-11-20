// The viewers for files Neovim shows: an image and a PDF from Neovim's
// bytes, and a markdown file's preview, sanitised by DOMPurify and put into
// the page, whose links never navigate it and whose images come from Neovim.
import "@/testing/dom";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { store } from "@/store";
import { cleanup, click, fakeNvim, render, settle } from "@/testing/render";
import { executable, PIECES, VECTORS } from "@/testing/xss";
import { fuzz } from "../../../lib/testing/fuzz";
import { ImageView, MarkdownView, PdfView } from "./Viewers";

afterEach(cleanup);

const files = (entries: [string, string][]) => new Map(entries);

describe("ImageView", () => {
  test("the image from Neovim's bytes, fitted; a click toggles actual size", async () => {
    const n = fakeNvim(files([["/p/cat.png", "blob:cat"]]));
    const { el } = render(<ImageView state={{ path: "/p/cat.png", name: "cat.png", mtime: 1, size: 2048 }} win={1} buf={1} focused nvim={n.nvim} />);
    await settle();
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:cat");
    expect(img.alt).toBe("cat.png");
    expect(n.calls.blobs).toEqual([["/p/cat.png", 1]]);
    expect(el.textContent).toBe("cat.png");
    // Its size once it has loaded.
    Object.defineProperties(img, { naturalWidth: { value: 64 }, naturalHeight: { value: 32 } });
    act(() => void img.dispatchEvent(new Event("load")));
    expect(el.textContent).toBe("cat.png · 64×32 · 2.0 KB");
    const frame = img.parentElement!;
    expect(frame.className).toContain("cursor-zoom-in");
    click(frame);
    expect(frame.className).toContain("cursor-zoom-out");
    expect(img.className).toBe("max-w-none");
  });

  test("fetched again only when the file changes", async () => {
    const n = fakeNvim(files([["/p/cat.png", "blob:cat"]]));
    const view = (mtime: number, selected?: boolean) => (
      <ImageView state={{ path: "/p/cat.png", name: "cat.png", mtime, ...(selected ? { size: 1 } : {}) }} win={1} buf={1} focused nvim={n.nvim} />
    );
    const { rerender } = render(view(1));
    await settle();
    rerender(view(1, true));
    await settle();
    rerender(view(2));
    await settle();
    expect(n.calls.blobs).toEqual([
      ["/p/cat.png", 1],
      ["/p/cat.png", 2],
    ]);
  });

  test("Neovim's error, or the file's", async () => {
    const n = fakeNvim();
    const { el } = render(<ImageView state={{ path: "/p/gone.png", name: "gone.png", mtime: 1 }} win={1} buf={1} focused nvim={n.nvim} />);
    await settle();
    expect(el.textContent).toBe("could not read: /p/gone.png: no such file");
    cleanup();
    const again = render(<ImageView state={{ path: "/p/big.png", name: "big.png", error: "too big" }} win={1} buf={1} focused nvim={n.nvim} />);
    await settle();
    expect(again.el.textContent).toBe("big.png: too big");
  });
});

describe("PdfView", () => {
  test("loading, then the browser's viewer in a frame", async () => {
    const n = fakeNvim(files([["/p/a.pdf", "blob:pdf"]]));
    const { el } = render(<PdfView state={{ path: "/p/a.pdf", name: "a.pdf", mtime: 1 }} win={1} buf={1} focused nvim={n.nvim} />);
    expect(el.textContent).toBe("Loading a.pdf…");
    await settle();
    const frame = el.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("blob:pdf");
    expect(frame.title).toBe("a.pdf");
  });

  test("the pointer leaving the frame gives the keys back, if the frame took them", async () => {
    const n = fakeNvim(files([["/p/a.pdf", "blob:pdf"]]));
    const { el } = render(<PdfView state={{ path: "/p/a.pdf", name: "a.pdf", mtime: 1 }} win={1} buf={1} focused nvim={n.nvim} />);
    await settle();
    const frame = el.querySelector("iframe")!;
    const leave = () => act(() => void frame.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    leave();
    expect(n.calls.refocus).toBe(0);
    act(() => frame.focus());
    expect(document.activeElement).toBe(frame);
    leave();
    expect(n.calls.refocus).toBe(1);
  });
});

type MdState = Parameters<typeof MarkdownView>[0]["state"];
function markdown(state: MdState, list: [string, string][] = []) {
  const n = fakeNvim(files(list));
  const r = render(<MarkdownView state={state} win={9} buf={1} focused nvim={n.nvim} />);
  return { ...n, ...r, body: r.el.querySelector("article")! };
}

describe("MarkdownView", () => {
  test("each top-level block wrapped with the line it starts on and how many it takes", () => {
    const { body } = markdown({ path: "/d/a.md", text: "# Title\n\nOne\ntwo\n\n- a\n- b\n" });
    expect([...body.children].map((b) => [b.getAttribute("data-line"), b.getAttribute("data-lines"), b.firstElementChild!.tagName])).toEqual([
      ["0", "1", "H1"],
      ["2", "1", "P"],
      ["5", "2", "UL"],
    ]);
  });

  test("a web link opens in a new tab; #anchor scrolls the preview; a path opens the file in Neovim", () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    try {
      const { body, calls } = markdown({ path: "/d/docs/a.md", text: "[w](https://a.example) [m](mailto:a@b.example) [s](#part-two) [f](../src/x%20y.ts#L3) [g](ftp://a.example)\n\n## Part two" });
      const links = [...body.querySelectorAll("a")];
      const target = body.querySelector("h2")!;
      // happy-dom gives headings no id, so the anchor names one.
      target.id = "part-two";
      let scrolled = 0;
      target.scrollIntoView = () => void scrolled++;
      for (const a of links) {
        const e = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => void a.dispatchEvent(e));
        expect(e.defaultPrevented).toBe(true);
      }
      expect(open.mock.calls).toEqual([
        ["https://a.example", "_blank", "noopener"],
        ["mailto:a@b.example", "_blank", "noopener"],
      ]);
      expect(scrolled).toBe(1);
      expect(calls.opened).toEqual([["/d/src/x y.ts", false]]);
    } finally {
      open.mockRestore();
    }
  });

  test("a relative image comes from Neovim beside the file; a missing one is its alt text", async () => {
    const { body, calls } = markdown(
      { path: "/d/docs/a.md", text: "![cat](img/cat.png?x=1) ![dog](../dog.png) ![web](https://a.example/w.png)" },
      [["/d/docs/img/cat.png", "blob:cat"]],
    );
    // None of them asked of the page before Neovim answers.
    const [cat, dog, web] = [...body.querySelectorAll("img")];
    expect(cat.hasAttribute("src")).toBe(false);
    expect(cat.dataset.src).toBe("img/cat.png?x=1");
    expect(web.getAttribute("src")).toBe("https://a.example/w.png");
    await settle();
    expect(calls.blobs.map((b) => b[0])).toEqual(["/d/docs/img/cat.png", "/d/dog.png"]);
    expect(cat.getAttribute("src")).toBe("blob:cat");
    expect(dog.isConnected).toBe(false);
    expect(body.querySelector(".missing")!.textContent).toBe("[dog]");
  });

  test("the card's actions along the top, each a call to Neovim", () => {
    const { el, take } = markdown({
      path: "/d/a.md",
      text: "x",
      actions: [
        { name: "done", key: "d", label: "Done" },
        { name: "delete", key: "D", label: "Delete", danger: true },
      ],
    });
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["d Done", "D Delete"]);
    expect(buttons[1].querySelector("span")!.className).toContain("text-destructive");
    click(buttons[1]);
    expect(take()).toEqual([["board.card_action", "delete"]]);
  });

  test("a scroll (the same text, merged in by main.tsx) leaves what's drawn as it was; new text rebuilds it", () => {
    const state = { path: "/d/a.md", text: "one\n\ntwo" };
    const { body, nvim, rerender } = markdown(state);
    const first = body.firstElementChild;
    rerender(<MarkdownView state={{ ...state, topline: 3 }} win={9} buf={1} focused nvim={nvim} />);
    expect(body.firstElementChild).toBe(first);
    rerender(<MarkdownView state={{ ...state, text: "one\n\nthree", topline: 3 }} win={9} buf={1} focused nvim={nvim} />);
    expect(body.firstElementChild).not.toBe(first);
    expect([...body.children].map((b) => b.textContent!.trim())).toEqual(["one", "three"]);
  });

  test("how many rows it takes goes to Neovim, once for each change", () => {
    const observers: (() => void)[] = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(readonly fn: () => void) {
        observers.push(fn);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { take, body } = markdown({ path: "/d/a.md", text: "x" });
      const { h } = store.get().cell;
      // happy-dom lays nothing out, so the body says how tall it is.
      let height = h * 3 - 1;
      Object.defineProperty(body, "offsetHeight", { get: () => height });
      act(() => observers.at(-1)!());
      act(() => observers.at(-1)!());
      height = h * 5;
      act(() => observers.at(-1)!());
      expect(take()).toEqual([
        ["board.fit_card", 9, 3],
        ["board.fit_card", 9, 5],
      ]);
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });
});

describe("MarkdownView's DOMPurify", () => {
  test("nothing that runs comes out of any of the markdown that tries", () => {
    for (const text of VECTORS) {
      const { body, unmount } = markdown({ path: "/d/a.md", text });
      expect({ text, found: executable(body) }).toEqual({ text, found: [] });
      unmount();
    }
  });

  test("not as images either: a relative src is fetched from Neovim, never from a script", () => {
    for (const text of ['<img src="x" onerror="alert(1)">', '<img src="javascript:alert(1)">', '<img srcset="javascript:alert(1) 1x">']) {
      const { body, unmount } = markdown({ path: "/d/a.md", text });
      for (const img of body.querySelectorAll("img")) {
        expect([...img.attributes].map((a) => a.name).filter((n) => n !== "data-src" && n !== "src")).toEqual([]);
        expect(img.getAttribute("src") ?? "").not.toMatch(/javascript/i);
      }
      unmount();
    }
  });
});

fuzz(
  "MarkdownView's output never runs anything",
  (g) => {
    let text = "";
    for (let n = g.size(40); n > 0; n--) text += g.bool(0.8) ? g.pick(PIECES) : g.string(8);
    const { body, unmount } = markdown({ path: "/d/a.md", text });
    const found = executable(body);
    unmount();
    if (found.length) throw new Error(`${JSON.stringify(text)}: ${found.join("; ")}`);
  },
  { runs: 300 },
);
