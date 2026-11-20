// A page for the tests that need one (happy-dom), imported first in each of
// them: not preloaded, so the rest keep Bun's globals and no window. What
// reads the page as it loads (the store's matchMedia and localStorage,
// DOMPurify) has to be imported after this; React DOM, which is CommonJS
// and so run before any ES module, is required by render.tsx. The page
// stays for the rest of the process (bun test --isolate gives each file its
// own), so Bun's own networking, timers and the like are kept, for the
// tests after this one that serve and connect.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const BUNS = [
  "fetch", "Request", "Response", "Headers", "FormData", "Blob", "File", "URL", "URLSearchParams", "WebSocket",
  "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "ReadableStream", "WritableStream", "TransformStream",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone", "crypto", "performance",
  "MessageChannel", "MessagePort", "BroadcastChannel",
];

if (!GlobalRegistrator.isRegistered) {
  const buns = new Map(BUNS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  GlobalRegistrator.register({ url: "http://localhost:4321/", width: 1280, height: 800 });
  for (const [k, d] of buns) if (d) Object.defineProperty(globalThis, k, d);
  nodeName();
  liveNodeIterator();
  quietFrames();
}

// happy-dom loads no frame (a PDF's, or one DOMPurify's parse makes before
// throwing it away), and says so on the console with its stack each time.
function quietFrames() {
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (args.length === 1 && args[0] instanceof Error && args[0].message.endsWith("Iframe page loading is disabled.")) return;
    error(...args);
  };
}

// React's act() warns outside an environment that says it's for tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The owner, on happy-dom's own classes, of what the global's prototype has.
function owner(proto: object | null, prop: string) {
  while (proto && !Object.hasOwn(proto, prop)) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error(`no ${prop} to replace`);
  return proto;
}

// DOM has one nodeName, on Node.prototype, and DOMPurify reads it from
// there (not as node.nodeName, which a form's input can shadow). happy-dom
// has its own on each kind of node and one on Node.prototype that is always
// "", so to DOMPurify every element was nameless, none of them allowed, and
// it threw everything away. Node.prototype's is made to be the node's own.
function nodeName() {
  const base = owner(Node.prototype, "nodeName");
  const own = Object.getOwnPropertyDescriptor(base, "nodeName")!.get!;
  Object.defineProperty(base, "nodeName", {
    configurable: true,
    get(this: Node) {
      for (let p = Object.getPrototypeOf(this); p && p !== base; p = Object.getPrototypeOf(p)) {
        const get = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
        if (get) return get.call(this);
      }
      return own.call(this);
    },
  });
}

// happy-dom's NodeIterator is a TreeWalker, which loses its place when the
// node it's on is removed: it ends there. A browser's moves back to the
// node before it (DOM's "NodeIterator pre-removal steps"). DOMPurify removes
// the node it's on as it walks, so under happy-dom it stopped at the first
// one it removed and left the rest, a <script> among them, as they were.
// This one goes on from the node before the one it returned whenever that
// one has left the tree, as a browser's does; DOMPurify takes
// createNodeIterator from the document when it loads, so this is put in
// before anything is imported. By childNodes, not firstChild: happy-dom's
// <template> has its content's as its firstChild and lastChild, and none in
// childNodes, where a browser's has none at all.
function liveNodeIterator() {
  const following = (n: Node, root: Node): Node | null => {
    if (n.childNodes[0]) return n.childNodes[0];
    for (let at: Node | null = n; at && at !== root; at = at.parentNode) if (at.nextSibling) return at.nextSibling;
    return null;
  };
  const preceding = (n: Node, root: Node): Node | null => {
    if (n === root) return null;
    let at = n.previousSibling;
    if (!at) return n.parentNode;
    while (at.childNodes.length) at = at.childNodes[at.childNodes.length - 1];
    return at;
  };
  const within = (n: Node, root: Node) => n === root || root.contains(n);

  class LiveNodeIterator {
    #ref: Node;
    // The node before #ref when it was returned, to go on from if it's removed.
    #before: Node | null = null;
    #started = false;
    constructor(
      readonly root: Node,
      readonly whatToShow = 0xffffffff,
      readonly filter: NodeFilter | null = null,
    ) {
      this.#ref = root;
    }
    #shown(n: Node) {
      if (!(this.whatToShow & (1 << (n.nodeType - 1)))) return false;
      const f = this.filter;
      if (!f) return true;
      return (typeof f === "function" ? f(n) : f.acceptNode(n)) === NodeFilter.FILTER_ACCEPT;
    }
    nextNode(): Node | null {
      let at: Node | null;
      if (!this.#started) {
        this.#started = true;
        at = this.root;
      } else if (within(this.#ref, this.root)) at = following(this.#ref, this.root);
      else {
        if (!this.#before || !within(this.#before, this.root)) throw new Error("LiveNodeIterator: the node before the one removed was removed too");
        at = following(this.#before, this.root);
      }
      for (; at; at = following(at, this.root)) {
        if (!this.#shown(at)) continue;
        this.#ref = at;
        this.#before = preceding(at, this.root);
        return at;
      }
      return null;
    }
    previousNode(): Node | null {
      throw new Error("LiveNodeIterator: previousNode isn't needed yet");
    }
    detach() {}
  }

  // On happy-dom's own Document, which the window's (the global Document)
  // and DOMParser's documents both inherit from.
  Object.defineProperty(owner(document, "createNodeIterator"), "createNodeIterator", {
    configurable: true,
    writable: true,
    value(root: Node, whatToShow?: number, filter?: NodeFilter | null) {
      return new LiveNodeIterator(root, whatToShow, filter);
    },
  });
}
