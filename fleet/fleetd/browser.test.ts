// A session's browser taken over from the phone, against a stand-in for the
// slot's Chromium: its DevTools' tab list and one page's socket, which
// records what it's sent and sends a frame once the screencast starts.
//   bun test fleet/fleetd
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn } from "./fleet";

const dir = mkdtempSync(join(tmpdir(), "fleet-browser-"));
const slot = { guestAddress: "127.0.0.1", stateDir: join(dir, "agent-0"), shareDir: join(dir, "agent-0/share"), outboxDir: join(dir, "agent-0/outbox"), unit: "agent-0.service" };

let fleet: typeof import("./fleet");
let browser: typeof import("./browser");

// What the page was sent, by method, and the tabs it lists.
let got: { method: string; params: any }[] = [];
let tabs: object[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  process.env.CORKBOARD_FLEET_STATE = join(dir, "fleet");
  process.env.CORKBOARD_FLEET_MANIFEST = join(dir, "fleet.json");
  process.env.CORKBOARD_STATE_DIR = join(dir, "state");
  writeFileSync(
    process.env.CORKBOARD_FLEET_MANIFEST,
    JSON.stringify({
      flake: "",
      owner: "matthew",
      memoryBudget: null,
      slots: { "agent-0": slot },
      residents: {},
      templates: { coding: { memory: 1, cores: 1, needsApproval: false, capNames: ["coding"] }, browser: { memory: 1, cores: 1, needsApproval: false, capNames: ["coding", "browser"] } },
      defaultAccount: "personal",
    }),
  );
  fleet = await import("./fleet");
  if (!fleet.SPAWNS.startsWith(dir)) throw new Error("fleet's paths aren't the test's");
  browser = await import("./browser");
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const p = new URL(req.url).pathname;
      if (p === "/json/list") return Response.json(tabs);
      if (p.startsWith("/devtools/page/") && srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data));
        got.push({ method: m.method, params: m.params });
        ws.send(JSON.stringify({ id: m.id, result: {} }));
        if (m.method === "Page.startScreencast")
          ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: "SlBFRw==", sessionId: 7, metadata: { deviceWidth: 400, deviceHeight: 800 } } }));
      },
    },
  });
});
afterAll(() => server.stop(true));

const spawn = (s: Partial<Spawn>): Spawn => {
  const x: Spawn = { id: "s1", template: "browser", task: "Log in", by: "user", account: "personal", state: "running", slot: "agent-0", created: "2026-11-22T00:00:00Z", interactive: true, ...s };
  fleet.write(x);
  return x;
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
  expect(ok()).toBe(true);
};

// A stream's messages and its end, as bridge/sessions.ts would hear them.
function phone() {
  const out: any[] = [];
  const ended = new Map<string, string>();
  const b = browser.browsers({ out: (s, d) => out.push({ s, ...JSON.parse(d) }), end: (s, why) => ended.set(s, why) }, () => `http://127.0.0.1:${server.port}`);
  return { b, out, ended };
}

test("a tap is the mouse at that fraction of the page; a key, down and up; Enter types a return", () => {
  const size = { width: 400, height: 800 };
  expect(browser.calls({ t: "tap", x: 0.5, y: 0.25 }, size)).toEqual([
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 200 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 200, y: 200, button: "left", buttons: 1, clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 200, y: 200, button: "left", buttons: 0, clickCount: 1 }],
  ]);
  expect(browser.calls({ t: "key", key: "Enter" }, size)).toEqual([
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }],
    ["Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
  ]);
  expect(browser.calls({ t: "scroll", x: 0.5, y: 0.5, dy: 0.5 }, size)).toEqual([["Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 400, deltaX: 0, deltaY: 400 }]]);
  expect(browser.calls({ t: "text", text: "hunter2" }, size)).toEqual([["Input.insertText", { text: "hunter2" }]]);
  expect(browser.calls({ t: "go", url: "example.com/login" }, size)).toEqual([["Page.navigate", { url: "https://example.com/login" }]]);
});

test("what isn't an input, or is outside the page, is refused; keys like the prototype's are no keys", () => {
  const size = { width: 400, height: 800 };
  for (const bad of [{ t: "tap", x: 2, y: 0 }, { t: "tap" }, { t: "text", text: "" }, { t: "key", key: "constructor" }, { t: "key", key: "__proto__" }, { t: "go", url: "" }, { t: "toString" }])
    expect(typeof browser.calls(bad, size)).toBe("string");
});

test("only pages are tabs, not an extension's background or DevTools", () => {
  expect(
    browser.pages([
      { id: "a", type: "page", title: "Sign in", url: "https://example.com" },
      { id: "b", type: "background_page", url: "chrome-extension://x/bg.html" },
      { id: "c", type: "page", url: "devtools://devtools/x" },
      { id: "d", type: "service_worker", url: "https://example.com/sw.js" },
    ]),
  ).toEqual([{ id: "a", title: "Sign in", url: "https://example.com" }]);
});

test("a session is a browser's only when its template has one", () => {
  const m = fleet.manifest();
  expect(browser.hasBrowser(m, "browser")).toBe(true);
  expect(browser.hasBrowser(m, "coding")).toBe(false);
  expect(browser.hasBrowser(m, "constructor")).toBe(false);
});

test("taken over: laid out for the phone, its frames streamed, taps put in, and put back when the phone goes", async () => {
  spawn({});
  tabs = [{ id: "p1", type: "page", title: "Sign in", url: "https://example.com/login" }];
  got = [];
  const { b, out, ended } = phone();
  await b.open("st1", "s1");
  await until(() => out.some((m) => m.frame));
  expect(out.find((m) => m.tabs)).toMatchObject({ s: "st1", tabs: [{ id: "p1", title: "Sign in" }], tab: "p1" });
  expect(out.find((m) => m.frame)).toMatchObject({ s: "st1", frame: "SlBFRw==", width: 400, height: 800 });
  expect(got.some((m) => m.method === "Page.screencastFrameAck" && m.params.sessionId === 7)).toBe(true);

  expect(await b.input("s1", { t: "size", width: 390, height: 700 })).toEqual({ ok: true });
  expect(got.find((m) => m.method === "Emulation.setDeviceMetricsOverride")?.params).toEqual({ width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
  expect(got.findLast((m) => m.method === "Page.startScreencast")?.params).toMatchObject({ maxWidth: 780, maxHeight: 1400 });

  got = [];
  expect(await b.input("s1", { t: "tap", x: 0.5, y: 0.5 })).toEqual({ ok: true });
  const mouse = got.filter((m) => m.method === "Input.dispatchMouseEvent");
  expect(mouse.map((m) => m.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  expect(mouse[1].params).toMatchObject({ x: 200, y: 400 });
  expect(await b.input("s1", { t: "text", text: "me@example.com" })).toEqual({ ok: true });
  expect(got.at(-1)).toEqual({ method: "Input.insertText", params: { text: "me@example.com" } });
  expect(await b.input("s1", { t: "key", key: "valueOf" })).toEqual({ error: expect.stringContaining("a key is one of") });

  // A second phone shares the page; it's put back only when both have gone.
  await b.open("st2", "s1");
  got = [];
  b.close("st1");
  expect(got).toEqual([]);
  b.close("st2");
  await until(() => got.some((m) => m.method === "Emulation.clearDeviceMetricsOverride"));
  expect(got.some((m) => m.method === "Page.stopScreencast")).toBe(true);
  expect(ended.size).toBe(0);
  expect(await b.input("s1", { t: "tap", x: 0, y: 0 })).toEqual({ error: "open the session's browser first" });
});

test("one with no browser, or none open yet, or no session, ends at once and says why", async () => {
  const { b, ended } = phone();
  spawn({ id: "s2", template: "coding" });
  await b.open("a", "s2");
  expect(ended.get("a")).toBe("that session has no browser");
  await b.open("b", "nope");
  expect(ended.get("b")).toBe("that session has ended");
  tabs = [];
  await b.open("c", "s1");
  expect(ended.get("c")).toBe("the browser has no page open");
  const closed = browser.browsers({ out: () => {}, end: (s, why) => ended.set(s, why) }, () => "http://127.0.0.1:1");
  await closed.open("d", "s1");
  expect(ended.get("d")).toBe("the agent hasn't opened its browser yet");
});

test("a page closed while watched moves the phone to another, and the last one closed ends it", async () => {
  tabs = [{ id: "p1", type: "page", url: "https://a" }, { id: "p2", type: "page", url: "https://b" }];
  const { b, out, ended } = phone();
  await b.open("st", "s1");
  tabs = [{ id: "p2", type: "page", url: "https://b" }];
  await until(() => out.some((m) => m.tab === "p2"), );
  tabs = [];
  await until(() => ended.has("st"));
  expect(ended.get("st")).toBe("the browser has no page open");
}, 10_000);
