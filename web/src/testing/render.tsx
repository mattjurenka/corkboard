// Rendering into the page dom.ts makes, inside act() so effects have run by
// the time a test looks, and a Neovim that keeps what it's told.

import { act } from "react";
import type { Root } from "react-dom/client";
import type { Nvim } from "@/nvim/context";

// Required, not imported: Bun runs a CommonJS module an import names before
// any ES module's body, so React DOM would look for a page before dom.ts has
// made one, find none, and never take an input event as a change.
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

const mounted = new Set<Root>();

export function render(ui: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  mounted.add(root);
  act(() => root.render(ui));
  return {
    el,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      mounted.delete(root);
      el.remove();
    },
  };
}

// Every root still up, for an afterEach.
export function cleanup() {
  for (const root of mounted) act(() => root.unmount());
  mounted.clear();
  document.body.innerHTML = "";
}

// Lets what's pending (a then on lua's promise) run, inside act.
export const settle = () => act(async () => {});

// A fake Neovim: lua and notify calls in order, how often focus went back,
// and the files blob() is to answer with (a path missing from them fails, as
// Neovim's errors do, with [type, message]).
export function fakeNvim(files = new Map<string, string>()) {
  const calls: { lua: unknown[][]; notify: unknown[][]; opened: unknown[][]; refocus: number; blobs: unknown[][] } = {
    lua: [],
    notify: [],
    opened: [],
    refocus: 0,
    blobs: [],
  };
  const nvim: Nvim = {
    rpc: { on: () => {}, request: async () => undefined, notify: () => {} } as unknown as Nvim["rpc"],
    lua: async (code, ...args) => void calls.lua.push([code, ...args]),
    notify: (method, ...params) => void calls.notify.push([method, ...params]),
    blob: async (path, version) => {
      calls.blobs.push([path, version]);
      const url = files.get(path);
      if (url === undefined) throw [0, `${path}: no such file`];
      return url;
    },
    media: async (url) => url,
    bridge: async () => new Response(),
    openFile: (path, tab) => void calls.opened.push([path, tab ?? false]),
    refocus: () => void calls.refocus++,
  };
  // The lua calls' code and arguments since the last take, the code cut to
  // the function it calls (require('corkboard.x').f(...) is x.f).
  const take = () =>
    calls.lua.splice(0).map(([code, ...args]) => {
      const m = /require\('corkboard\.([\w.]+)'\)\.(\w+)/.exec(code as string);
      return [m ? `${m[1]}.${m[2]}` : code, ...args];
    });
  return { nvim, calls, take };
}

// Events as the browser sends them, inside act.
export function click(el: Element, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, ...init }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

export function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => void el.dispatchEvent(e));
  return e;
}

// Typed into a field: its value set as the browser would (past React's
// tracker of it), then the input event React's onChange listens for.
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function focus(el: HTMLElement) {
  act(() => el.focus());
}

export function blur(el: HTMLElement) {
  act(() => el.blur());
}

// The elements matching a selector whose text is text.
export const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter((e) => e.textContent?.trim() === text);
export const one = (root: ParentNode, selector: string, text: string) => {
  const found = byText(root, selector, text);
  if (found.length !== 1) throw new Error(`${found.length} ${selector} with text ${JSON.stringify(text)}`);
  return found[0];
};
