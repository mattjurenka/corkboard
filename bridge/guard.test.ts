import { afterAll, describe, expect, it } from "bun:test";
import { TOKEN_PROTOCOL, guard, isLoopback } from "./guard";

const TOKEN = "s3cret.token-1";

// A request as a browser makes it: its Host, its Origin, and the protocols
// the page offers (the page's always offers "corkboard").
const req = (host: string, origin?: string, protocols: string[] = ["corkboard"], more: Record<string, string> = {}) =>
  new Request(`http://${host}/nvim`, { headers: { host, ...(origin && { origin }), "sec-websocket-protocol": protocols.join(", "), ...more } });
const page = (token = TOKEN) => ["corkboard", TOKEN_PROTOCOL + token];

describe("loopback names", () => {
  it("are localhost and its names, 127/8 and ::1, and nothing a DNS name can be", () => {
    for (const n of ["localhost", "dev.corkboard.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) expect([n, isLoopback(n)]).toEqual([n, true]);
    for (const n of ["localhost.evil.test", "127.0.0.1.nip.io", "evil.test", "0.0.0.0", "128.0.0.1", "[::2]", "", "localhostx"]) expect([n, isLoopback(n)]).toEqual([n, false]);
  });
});

describe("a loopback bridge's socket", () => {
  const g = guard({ local: true, token: "" });

  it("opens for its own page, with no token to ask for", () => {
    expect(g.socket(req("127.0.0.1:7777", "http://127.0.0.1:7777"))).toEqual({ headers: { "sec-websocket-protocol": "corkboard" } });
    expect(g.socket(req("localhost:7777", "http://localhost:7777", []))).toEqual({ headers: undefined });
  });

  it("not for another site's page, nor one with no Origin", () => {
    expect(g.socket(req("127.0.0.1:7777", "https://evil.test"))).toEqual({ refused: "wrong origin: https://evil.test" });
    expect(g.socket(req("127.0.0.1:7777", "http://127.0.0.1:7778"))).toEqual({ refused: "wrong origin: http://127.0.0.1:7778" });
    expect(g.socket(req("127.0.0.1:7777"))).toEqual({ refused: "wrong origin: null" });
    expect(g.socket(req("127.0.0.1:7777", "null"))).toEqual({ refused: "wrong origin: null" });
  });

  it("not for a site whose name was rebound to loopback, though it's its own origin", () => {
    expect(g.socket(req("evil.test:7777", "http://evil.test:7777"))).toEqual({ refused: "wrong host: evil.test:7777" });
    expect(g.socket(req("localhost.evil.test:7777", "http://localhost.evil.test:7777"))).toEqual({ refused: "wrong host: localhost.evil.test:7777" });
    expect(g.refuseFetch(req("evil.test:7777", undefined, [], { "sec-fetch-site": "same-origin" }))).toBe("wrong host: evil.test:7777");
    // A Host that isn't one is refused, not thrown at.
    expect(g.socket(req("", "http://127.0.0.1:7777"))).toEqual({ refused: "wrong host: " });
  });

  it("takes a plain GET from its page by Sec-Fetch-Site when there's no Origin", () => {
    expect(g.refuseFetch(req("127.0.0.1:7777", undefined, [], { "sec-fetch-site": "same-origin" }))).toBeUndefined();
    expect(g.refuseFetch(req("127.0.0.1:7777", undefined, [], { "sec-fetch-site": "cross-site" }))).toBe("not from this page: cross-site");
    expect(g.refuseFetch(req("127.0.0.1:7777"))).toBe("not from this page: null");
    expect(g.refuseFetch(req("127.0.0.1:7777", "https://evil.test", [], { "sec-fetch-site": "same-origin" }))).toBe("wrong origin: https://evil.test");
  });
});

describe("a bridge with a token", () => {
  const g = guard({ local: false, token: TOKEN });

  it("opens the socket with the token, and closes it without, or with another", () => {
    const host = "10.0.0.5:7777";
    const origin = "http://10.0.0.5:7777";
    expect(g.socket(req(host, origin, page()))).toEqual({ headers: { "sec-websocket-protocol": "corkboard" } });
    for (const protocols of [["corkboard"], page("wrong"), page(TOKEN + "x"), page(TOKEN.slice(0, -1)), page(""), ["corkboard", TOKEN]]) {
      expect(g.socket(req(host, origin, protocols))).toEqual({ error: "wrong or missing token: open the URL the bridge printed", headers: { "sec-websocket-protocol": "corkboard" } });
    }
    // Another site's page with the token is still refused.
    expect(g.socket(req(host, "https://evil.test", page()))).toEqual({ refused: "wrong origin: https://evil.test" });
    // Beyond loopback, the Host is the Origin's to match, not loopback's.
    expect(g.socket(req("evil.test:7777", "http://evil.test:7777", page()))).toEqual({ headers: { "sec-websocket-protocol": "corkboard" } });
  });

  it("compares the token whole", () => {
    expect(g.sameToken(TOKEN)).toBe(true);
    for (const t of ["", TOKEN + " ", TOKEN.toUpperCase(), "s3cret"]) expect([t, g.sameToken(t)]).toEqual([t, false]);
  });
});

describe("a bridge behind a proxy", () => {
  const ORIGIN = "https://valheim.test:8443";
  const g = guard({ local: true, origin: ORIGIN, token: TOKEN });

  it("opens for the proxy's origin whatever Host it sends, and for no other", () => {
    expect(g.socket(req("127.0.0.1:7777", ORIGIN, page()))).toEqual({ headers: { "sec-websocket-protocol": "corkboard" } });
    expect(g.socket(req("anything:1", ORIGIN, page()))).toEqual({ headers: { "sec-websocket-protocol": "corkboard" } });
    expect(g.socket(req("127.0.0.1:7777", "http://127.0.0.1:7777", page()))).toEqual({ refused: "wrong origin: http://127.0.0.1:7777" });
    expect(g.socket(req("127.0.0.1:7777", undefined, page()))).toEqual({ refused: "wrong origin: null" });
    expect(g.socket(req("127.0.0.1:7777", ORIGIN, ["corkboard"]))).toMatchObject({ error: expect.stringContaining("wrong or missing token") });
  });
});

// The same over a real socket, served as server.ts serves /nvim.
describe("the socket itself", () => {
  const g = guard({ local: true, token: TOKEN });
  const server = Bun.serve<{ error?: string }, {}>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(r, s) {
      const checked = g.socket(r);
      if ("refused" in checked) return new Response(checked.refused, { status: 403 });
      return s.upgrade(r, { data: { error: checked.error }, headers: checked.headers }) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.error) return ws.close(4000, ws.data.error);
        ws.send("open");
      },
      message() {},
    },
  });
  afterAll(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;

  // How it ended: its first message, or its close (or a refused upgrade's error).
  const dial = (protocols: string[], headers: Record<string, string>) =>
    new Promise<string>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/nvim`, { protocols, headers } as any);
      ws.onmessage = (e) => {
        done(`${ws.protocol} ${e.data}`);
        ws.close();
      };
      ws.onclose = (e) => done(`closed ${e.code} ${e.reason}`);
      ws.onerror = () => done("refused");
    });

  it("opens for the page with its token, naming the protocol it offered", async () => {
    expect(await dial(page(), { origin })).toBe("corkboard open");
  });

  it("closes with why for a wrong token, and refuses a foreign Origin or a rebound Host", async () => {
    expect(await dial(page("wrong"), { origin })).toBe("closed 4000 wrong or missing token: open the URL the bridge printed");
    expect(await dial(["corkboard"], { origin })).toBe("closed 4000 wrong or missing token: open the URL the bridge printed");
    expect(await dial(page(), { origin: "https://evil.test" })).toBe("refused");
    const res = await fetch(`${origin}/nvim`, { headers: { origin, host: "evil.test", connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-protocol": page().join(", ") } });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("wrong host: evil.test");
  });
});
