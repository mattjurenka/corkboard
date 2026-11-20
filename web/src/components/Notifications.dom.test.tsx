// The page's notifications (attention.ts) and the sidebar's list of them,
// and the toasts in the editor's corner: what's recorded, what's unread,
// what a click on one opens.
import "@/testing/dom";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { clearNotifications, notifyAttention, notifyBack, notifyClaude, notifyMessage } from "@/attention";
import { store } from "@/store";
import { cleanup, click, one, render } from "@/testing/render";
import { Notifications } from "./Notifications";
import { Toasts } from "./Toasts";

afterEach(() => {
  cleanup();
  act(() => {
    clearNotifications();
    store.set({ toasts: [] });
  });
});

const titles = () => store.get().notifications.map((n) => n.title);

describe("attention", () => {
  test("Neovim's warnings and errors are listed, newest first, raising nothing", () => {
    act(() => notifyMessage({ level: "warning", text: "careful" }));
    act(() => notifyMessage({ level: "error", text: "broke" }));
    expect(store.get().notifications.map((n) => [n.title, n.body, n.shown, n.reason])).toEqual([
      ["Error", "broke", false, undefined],
      ["Warning", "careful", false, undefined],
    ]);
    expect(store.get().unread).toBe(2);
  });

  test("this page may not send notifications (happy-dom has none): one that would have says why", () => {
    expect("Notification" in window).toBe(false);
    act(() => notifyBack());
    expect(store.get().notifications[0]).toMatchObject({ shown: false, reason: "this page may not send notifications" });
  });

  test("a card's question notifies once it's new, and again only when it changes; the first state only records", () => {
    const opened: string[] = [];
    const open = (id: string) => opened.push(id);
    act(() => notifyAttention([{ id: "c-1", title: "One", attention: "Which?" }], open));
    expect(titles()).toEqual([]);
    act(() => notifyAttention([{ id: "c-1", title: "One", attention: "Which?" }, { id: "c-2", title: "Two", agent: "claude", attention: "Ok?" }], open));
    act(() => notifyAttention([{ id: "c-1", title: "One", attention: "Which now?" }, { id: "c-2", title: "Two", agent: "claude", attention: "Ok?" }], open));
    expect(store.get().notifications.map((n) => [n.title, n.body])).toEqual([
      ["An agent needs you", "One\nWhich now?"],
      ["claude needs you", "Two\nOk?"],
    ]);
    store.get().notifications[1].open!();
    expect(opened).toEqual(["c-2"]);
    // Answered and asked again: new again.
    act(() => notifyAttention([], open));
    act(() => notifyAttention([{ id: "c-2", title: "Two", attention: "Ok?" }], open));
    expect(titles()[0]).toBe("An agent needs you");
  });

  test("a Claude Code session's, by its project, held back only while this window has focus", () => {
    const bufs: number[] = [];
    act(() => notifyClaude({ message: "done", cwd: "/home/me/src/proj", sent: false, buf: 4 }, (b) => bufs.push(b)));
    act(() => notifyClaude({ message: "hi", sent: true, label: "Pepper" }, () => {}));
    const [hi, done] = store.get().notifications;
    expect([hi.title, hi.reason]).toEqual(["Pepper", "this page may not send notifications"]);
    expect(done.title).toBe("Claude Code · proj");
    expect(document.hasFocus()).toBe(true);
    expect(done.reason).toBe("held back by Claude Code");
    done.open!();
    expect(bufs).toEqual([4]);
    expect(hi.open).toBeUndefined();
    // Looked away, one held back would have been shown.
    const focus = spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      act(() => notifyClaude({ message: "later", sent: false, reason: "idle" }, () => {}));
      expect(store.get().notifications[0].reason).toBe("this page may not send notifications");
    } finally {
      focus.mockRestore();
    }
  });
});

describe("Notifications", () => {
  test("folded: a count of the unread; opened: newest first, read as they come, a click opens one, and clear", () => {
    const { el } = render(<Notifications />);
    expect(el.textContent).toBe("▸Notifications");
    let opened = 0;
    act(() => {
      notifyMessage({ level: "warning", text: "a\nb" });
      store.set({ notifications: [{ id: 99, time: Date.now(), title: "Click me", body: "x", shown: false, reason: "why", open: () => opened++ }, ...store.get().notifications], unread: store.get().unread + 1 });
    });
    const header = el.querySelector<HTMLButtonElement>("button[title='Show notifications']")!;
    expect(header.textContent).toBe("▸Notifications● 2");
    click(header);
    expect(store.get().unread).toBe(0);
    const items = [...el.querySelectorAll("li")];
    expect(items.map((li) => li.querySelector(".text-primary")!.textContent)).toEqual(["Click me", "Warning"]);
    expect(items[0].textContent).toContain("not shown: why");
    click(items[0]);
    expect(opened).toBe(1);
    expect(items[1].className).not.toContain("cursor-pointer");
    // Arriving while open, read at once.
    act(() => notifyMessage({ level: "error", text: "now" }));
    expect(store.get().unread).toBe(0);
    click(one(el, "button", "clear"));
    expect(store.get().notifications).toEqual([]);
    expect(one(el, "li", "none yet")).toBeTruthy();
  });
});

describe("Toasts", () => {
  test("none, nothing; a spinner while pending, then ✓ or ✗", () => {
    const { el } = render(<Toasts />);
    expect(el.innerHTML).toBe("");
    act(() =>
      store.set({
        toasts: [
          { id: "a", kind: "pending", text: "Pushing" },
          { id: "b", kind: "done", text: "Pushed" },
          { id: "c", kind: "error", text: "Failed" },
        ],
      }),
    );
    const items = [...el.querySelectorAll("li")];
    expect(items.map((li) => li.lastElementChild!.textContent)).toEqual(["Pushing", "Pushed", "Failed"]);
    expect(items[0].firstElementChild!.hasAttribute("data-ambient")).toBe(true);
    expect(items.slice(1).map((li) => li.firstElementChild!.textContent)).toEqual(["✓", "✗"]);
    expect(items[2].className).toContain("border-destructive");
  });

  test("the spinner turns", async () => {
    const { el } = render(<Toasts />);
    act(() => store.set({ toasts: [{ id: "a", kind: "pending", text: "…" }] }));
    const frame = () => el.querySelector("[data-ambient]")!.textContent;
    const first = frame();
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(frame()).not.toBe(first);
  });
});
