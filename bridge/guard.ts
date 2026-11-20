// Who may open the bridge's socket and call it (server.ts): the checks on
// Origin, Host and the token, apart from the server so they can be tried.
//
// Whoever can reach the socket can run arbitrary code through Neovim. Origin
// must be this bridge's own page, so another site open in the browser can't
// connect. A loopback bridge also wants a loopback Host, or a site whose
// name was rebound to 127.0.0.1 would be its own origin. Behind a proxy
// (origin), the socket opens for the proxy's public origin only, whatever
// Host the proxy sends.

import { timingSafeEqual } from "node:crypto";

// Loopback names, for the bind address and for the Host a loopback bridge
// accepts. Browsers resolve *.localhost to loopback themselves, never by
// DNS, so names like dev.corkboard.localhost can't be rebound either.
export const isLoopback = (name: string) => /^((.+\.)?localhost|127(\.\d+){3}|::1)$/.test(name.replace(/^\[(.*)\]$/, "$1"));

// The token goes in Sec-WebSocket-Protocol, after this.
export const TOKEN_PROTOCOL = "corkboard.token.";

// local: bound to loopback. origin: the proxy's public origin, if behind one.
// token: what the page must send, or "" for none.
export function guard(c: { local: boolean; origin?: string; token: string }) {
  const sameToken = (given: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(c.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // Why an upgrade is refused, if it is.
  function refuse(req: Request): string | undefined {
    const host = req.headers.get("host") ?? "";
    const origin = req.headers.get("origin");
    if (c.origin) return origin === c.origin ? undefined : `wrong origin: ${origin}`;
    if (c.local && !isLoopback(URL.parse(`http://${host}`)?.hostname ?? "")) return `wrong host: ${host}`;
    if (!origin || URL.parse(origin)?.host !== host) return `wrong origin: ${origin}`;
  }

  // The same for a request the page may make as a plain GET, which a browser
  // sends with no Origin when it's same-origin: then its Sec-Fetch-Site says.
  function refuseFetch(req: Request): string | undefined {
    if (req.headers.has("origin")) return refuse(req);
    const host = req.headers.get("host") ?? "";
    if (c.local && !isLoopback(URL.parse(`http://${host}`)?.hostname ?? "")) return `wrong host: ${host}`;
    if (req.headers.get("sec-fetch-site") !== "same-origin") return `not from this page: ${req.headers.get("sec-fetch-site")}`;
  }

  // /nvim's upgrade: refused (403, before any socket), or a socket whose
  // error, if any, it is closed with before Neovim starts, which the page
  // can show; a refused upgrade it can't. headers: the reply's, naming the
  // protocol the page offered, without which the browser drops the socket.
  function socket(req: Request): { refused: string } | { error?: string; headers?: Record<string, string> } {
    const why = refuse(req);
    if (why) return { refused: why };
    const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
    const token = offered.find((p) => p.startsWith(TOKEN_PROTOCOL))?.slice(TOKEN_PROTOCOL.length);
    const headers = offered.includes("corkboard") ? { "sec-websocket-protocol": "corkboard" } : undefined;
    if (c.token && !(token && sameToken(token))) return { error: "wrong or missing token: open the URL the bridge printed", headers };
    return { headers };
  }

  return { sameToken, refuse, refuseFetch, socket };
}
