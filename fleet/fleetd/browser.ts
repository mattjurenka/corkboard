// A session's browser, taken over from the phone: the page its agent has
// open in the slot's Chromium (fleet/caps/browser-mcp.ts), streamed as
// frames, and the user's taps and typing put into it, so a login is the
// user's own and the password never passes through the agent. The guest
// forwards Chromium's DevTools port to its tap (fleet/caps/browser.nix),
// which only the host can reach.
//
// A stream's "out" is JSON: { frame, width, height } (a JPEG, base64, and
// the page's size in CSS pixels), or { tabs, tab } as they change. What's
// put in (input) is { t: "tap" | "scroll" | "text" | "key" | "back" | "go" |
// "tab" | "size", ... }, positions as fractions of the frame. While a phone
// watches, the page is laid out for its screen; when the last one goes,
// it's put back as the agent had it.

import { type Manifest, manifest, spawns } from "./fleet";

export const PORT = 9223;

type Tab = { id: string; title: string; url: string };
type Out = { out(stream: string, data: string): void; end(stream: string, why: string): void };

// The CDP key events the phone sends, as Chromium wants them.
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
};

const frac = (x: unknown) => (typeof x === "number" && x >= 0 && x <= 1 ? x : null);

// Pages, not an extension's background or a worker.
export function pages(list: { id?: unknown; type?: unknown; title?: unknown; url?: unknown }[]): Tab[] {
  return list
    .filter((t) => t.type === "page" && typeof t.id === "string" && !String(t.url).startsWith("devtools://"))
    .map((t) => ({ id: t.id as string, title: String(t.title ?? ""), url: String(t.url ?? "") }));
}

// The CDP calls for one thing the phone did, or why it can't be done.
// size is the page's, in CSS pixels, as the last frame said.
export function calls(input: Record<string, unknown>, size: { width: number; height: number }): [string, object][] | string {
  const at = () => {
    const x = frac(input.x), y = frac(input.y);
    return x === null || y === null ? null : { x: Math.round(x * size.width), y: Math.round(y * size.height) };
  };
  switch (input.t) {
    case "tap": {
      const p = at();
      if (!p) return "a tap is x and y, fractions of the frame";
      return [
        ["Input.dispatchMouseEvent", { type: "mouseMoved", ...p }],
        ["Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 }],
        ["Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 }],
      ];
    }
    case "scroll": {
      const p = at();
      const dx = Number(input.dx ?? 0), dy = Number(input.dy ?? 0);
      if (!p || !Number.isFinite(dx) || !Number.isFinite(dy)) return "a scroll is x, y, and dx, dy in fractions of the frame";
      return [["Input.dispatchMouseEvent", { type: "mouseWheel", ...p, deltaX: Math.round(dx * size.width), deltaY: Math.round(dy * size.height) }]];
    }
    case "text":
      if (typeof input.text !== "string" || !input.text || input.text.length > 4096) return "text is a string, under 4096 characters";
      return [["Input.insertText", { text: input.text }]];
    case "key": {
      const k = typeof input.key === "string" && Object.hasOwn(KEYS, input.key) ? KEYS[input.key] : null; // keys: the table's own
      if (!k) return `a key is one of ${Object.keys(KEYS).join(", ")}`;
      const key = input.key as string;
      return [
        ["Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text && { text: k.text }) }],
        ["Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk }],
      ];
    }
    case "back":
      return [["Runtime.evaluate", { expression: "history.back()" }]];
    case "go": {
      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (!url || url.length > 2048) return "go is a url";
      return [["Page.navigate", { url: /^[a-z][a-z+.-]*:/i.test(url) ? url : `https://${url}` }]];
    }
    default:
      return `no input ${String(input.t)}`;
  }
}

// One session's page, while someone watches it.
class View {
  private ws: WebSocket | null = null;
  private next = 1;
  private replies = new Map<number, (r: { result?: any; error?: { message: string } }) => void>();
  private tabs: Tab[] = [];
  private tab: string | null = null;
  private poll?: ReturnType<typeof setInterval>;
  private screen: { width: number; height: number } | null = null;
  private closed = false;
  size = { width: 1280, height: 800 };
  readonly watchers = new Set<string>();

  constructor(
    private base: string,
    private out: Out,
    private gone: () => void,
  ) {}

  private say(m: object) {
    for (const s of this.watchers) this.out.out(s, JSON.stringify(m));
  }

  private send(method: string, params: object = {}): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the browser isn't connected"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, (r) => (r.error ? reject(new Error(r.error.message)) : resolve(r.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private async list(): Promise<Tab[]> {
    const res = await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`the browser said ${res.status}`);
    return pages((await res.json()) as any[]);
  }

  // Connected to the tab, laid out for the phone, and its frames coming.
  private async open(id: string) {
    this.ws?.close();
    this.tab = id;
    const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/devtools/page/${id}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the browser didn't let us in"));
    });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.id === "number") {
        this.replies.get(m.id)?.(m);
        this.replies.delete(m.id);
      } else if (m.method === "Page.screencastFrame") {
        const { data, metadata, sessionId } = m.params;
        void this.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        this.size = { width: metadata.deviceWidth, height: metadata.deviceHeight };
        this.say({ frame: data, width: metadata.deviceWidth, height: metadata.deviceHeight });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const r of this.replies.values()) r({ error: { message: "the browser closed" } });
      this.replies.clear();
    };
    await this.layout();
  }

  private async layout() {
    if (this.screen) {
      const { width, height } = this.screen;
      await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    }
    await this.send("Page.stopScreencast").catch(() => {});
    const w = this.screen?.width ?? 1280, h = this.screen?.height ?? 800;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: w * 2, maxHeight: h * 2 });
  }

  // The tabs as they change; a closed tab's watchers go to another.
  private async look() {
    const tabs = await this.list();
    if (JSON.stringify(tabs) === JSON.stringify(this.tabs)) return;
    this.tabs = tabs;
    if (!tabs.length) return this.close("the browser has no page open");
    if (!tabs.some((t) => t.id === this.tab)) await this.open(tabs[0].id);
    this.say({ tabs, tab: this.tab });
  }

  async start() {
    const tabs = await this.list();
    if (!tabs.length) throw new Error("the browser has no page open");
    await this.open(tabs[0].id);
    this.tabs = tabs;
    this.say({ tabs, tab: this.tab });
    this.poll = setInterval(() => void this.look().catch((e) => this.close((e as Error).message)), 2000);
  }

  async input(i: Record<string, unknown>) {
    if (i.t === "tab") {
      if (typeof i.id !== "string" || !this.tabs.some((t) => t.id === i.id)) throw new Error("no such tab");
      await this.open(i.id);
      return this.say({ tabs: this.tabs, tab: this.tab });
    }
    if (i.t === "size") {
      const width = Number(i.width), height = Number(i.height);
      if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 200 && height >= 200 && width <= 2000 && height <= 2000))
        throw new Error("a size is whole CSS pixels, 200 to 2000");
      this.screen = { width, height };
      return this.layout();
    }
    const c = calls(i, this.size);
    if (typeof c === "string") throw new Error(c);
    for (const [method, params] of c) await this.send(method, params);
  }

  // Put back as the agent had it.
  close(why?: string) {
    if (this.closed) return;
    this.closed = true;
    this.gone();
    clearInterval(this.poll);
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) {
      const id = this.next++;
      ws.send(JSON.stringify({ id, method: "Page.stopScreencast" }));
      ws.send(JSON.stringify({ id: id + 1, method: "Emulation.clearDeviceMetricsOverride" }));
      setTimeout(() => ws.close(), 500);
    } else ws?.close();
    const watchers = [...this.watchers];
    this.watchers.clear();
    for (const s of watchers) this.out.end(s, why ?? "closed");
  }
}

// Whether the session's template has a browser.
export function hasBrowser(m: Manifest, template: string): boolean {
  const t = Object.hasOwn(m.templates, template) ? m.templates[template] : undefined; // keys: a Dict, but say so
  return !!t?.capNames.includes("browser");
}

// The streams fleetd's sessions serve (bridge/sessions.ts's Browsers).
// at: where a slot's forwarded DevTools are, given its guest's address.
export function browsers(out: Out, at = (address: string) => `http://${address}:${PORT}`) {
  const views = new Map<string, View>();
  const of = new Map<string, string>();
  return {
    async open(stream: string, key: string) {
      const m = manifest();
      const s = spawns().find((x) => x.id === key && x.interactive && x.state === "running" && x.slot);
      if (!s || !m.slots[s.slot!]) return out.end(stream, "that session has ended");
      if (!hasBrowser(m, s.template)) return out.end(stream, "that session has no browser");
      of.set(stream, key);
      let v = views.get(key);
      if (v) {
        v.watchers.add(stream);
        return;
      }
      v = new View(at(m.slots[s.slot!].guestAddress), out, () => views.delete(key));
      views.set(key, v);
      v.watchers.add(stream);
      await v.start().catch((e) => {
        const msg = (e as Error).message;
        v!.close(/fetch|connect|refused|timed? ?out/i.test(msg) ? "the agent hasn't opened its browser yet" : msg);
      });
    },
    close(stream: string) {
      const key = of.get(stream);
      of.delete(stream);
      const v = key ? views.get(key) : undefined;
      if (!v?.watchers.delete(stream)) return;
      if (!v.watchers.size) v.close();
    },
    async input(key: string, input: Record<string, unknown>) {
      const v = views.get(key);
      if (!v) return { error: "open the session's browser first" };
      try {
        await v.input(input);
        return { ok: true };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };
}
