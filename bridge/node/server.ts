// What the node answers over HTTP. It listens on plain HTTP on this
// machine; TLS ends on this machine too, in Tailscale Funnel or Caddy in
// front of it (the plan's "Reachability").
//
//   GET  /health                       { ok }: no token, says nothing about the account
//   /.well-known/..., /register, /authorize, /token     oauth.ts
//   POST /mcp                          mcp.ts, with a token
//   /api/node/...                      the phone's API, with a token:
//     GET   status                     which objects are synced, and how far
//     GET   boards                     [{ key, cards: [summary] }]
//     GET   boards/:key/cards          ?log=1 with their logs, ?all=1 archived too
//     POST  boards/:key/cards          fields: a new card
//     GET   boards/:key/cards/:id
//     PATCH boards/:key/cards/:id      fields
//     POST  boards/:key/cards/:id/log  { note, who? }
//     GET   brains                     each brain's settings and counts
//     GET   brains/:name/notes         ?q=&kind=&limit=
//     GET   brains/:name/notes/:id
//     PUT   brains/:name/notes/:id     { kind, title, body, version? }
//     GET   brains/:name/recall        ?q=&limit=
//     GET   brains/:name/entries       ?from=&to=
//     POST  brains/:name/remember      { text, who? }
//     POST  calendar                   { date, day: { blocks } }: an accepted plan onto the calendar (owner)
//
// The origin (what tokens, metadata and redirects name) is --origin, or
// else the request's Host: https unless it's this machine.

import { BRAIN_ONLY_KINDS, type Plan, blocks as checkBlocks, date as checkDate, note as checkNote, noteId } from "../../lib/model/plans";
import { waitingOn } from "../../lib/model/cards";
import { type Data, Invalid } from "./data";
import { type Caller, type Consent, OAuthError, type OAuthStore, Redirect, SCOPES, deniedUrl } from "./oauth";
import { mcp } from "./mcp";
import type { Search } from "./search";
import { type CalendarConfig, CalendarError, writePlan } from "./calendar";

export type NodeOptions = {
  data: Data;
  search: Search;
  oauth: OAuthStore;
  origin?: string;
  // The calendar's config, read when a plan is written, so a login while
  // the node runs takes effect.
  calendar?: () => CalendarConfig | undefined;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>
  :root { --bg: #fafaf7; --fg: #1d1d1b; --muted: #6b6b66; --line: #d6d6cf; --accent: #1f5fd1; --warn: #a3470c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e8e3; --muted: #9a9a93; --line: #3a3a37; --accent: #7aa7ff; --warn: #f0a060; } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.6 ui-monospace, "JetBrains Mono", Menlo, monospace; margin: 0; }
  main { max-width: 34rem; margin: 4rem auto; padding: 0 16px; }
  h1 { font-size: 1rem; margin: 0 0 1.5rem; border-bottom: 1px solid var(--line); padding-bottom: .75rem; }
  p { margin: 0 0 1rem; } .muted { color: var(--muted); } .warn { color: var(--warn); }
  input { font: inherit; letter-spacing: .2em; padding: .3rem .5rem; width: 10ch; border: 1px solid var(--line); background: none; color: inherit; }
  button { font: inherit; padding: .4rem 1rem; margin: 1rem .5rem 0 0; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
  button[value=approve] { border-color: var(--accent); color: var(--accent); }
</style>
<main><h1>corkboard node · ${escape(title)}</h1>${body}</main>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } },
  );
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const OPEN = { "Access-Control-Allow-Origin": "*" };
const oauthError = (e: OAuthError) => json({ error: e.code, error_description: e.message }, e.status, OPEN);

export function originOf(req: Request, fixed?: string): string {
  if (fixed) return fixed.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("Host") ?? url.host;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = req.headers.get("X-Forwarded-Proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

export function node(o: NodeOptions) {
  const consents = new Map<string, Consent>();

  const consentPage = (id: string, c: Consent, wrong = "") =>
    page(
      "connect",
      `<p>${escape(c.client.name)}</p>
<p class="muted">→ ${escape(new URL(c.redirect_uri).host || c.redirect_uri)}</p>
<p class="muted">${escape(c.scope)}</p>
${wrong ? `<p class="warn">${escape(wrong)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escape(id)}">
<label>code <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus></label><br>
<button name="action" value="approve">approve</button><button name="action" value="deny">deny</button>
</form>`,
    );

  async function authorize(req: Request, origin: string): Promise<Response> {
    if (req.method === "GET") {
      try {
        const c = await o.oauth.request(new URL(req.url).searchParams, origin);
        const id = crypto.randomUUID();
        const t = Date.now();
        for (const [k, v] of consents) if (v.made < t - 10 * 60_000) consents.delete(k);
        consents.set(id, c);
        return consentPage(id, c);
      } catch (e) {
        if (e instanceof Redirect) return Response.redirect(e.to, 302);
        if (e instanceof OAuthError) return page("can't connect", `<p class="warn">${escape(e.message)}</p>`, 400);
        throw e;
      }
    }
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const form = await req.formData();
    const id = String(form.get("request") ?? "");
    const c = consents.get(id);
    if (!c || c.made < Date.now() - 10 * 60_000) return page("can't connect", `<p class="warn">this request has expired; start again from the client</p>`, 400);
    if (form.get("action") !== "approve") {
      consents.delete(id);
      return Response.redirect(deniedUrl(c, origin), 302);
    }
    try {
      if (!o.oauth.spendApproval(String(form.get("code") ?? ""))) return consentPage(id, c, "wrong code");
    } catch (e) {
      if (e instanceof OAuthError) return consentPage(id, c, e.message);
      throw e;
    }
    consents.delete(id);
    return Response.redirect(o.oauth.approve(c, origin), 302);
  }

  async function token(req: Request, origin: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...OPEN, "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    let p: URLSearchParams;
    const type = req.headers.get("Content-Type") ?? "";
    if (type.includes("application/json")) p = new URLSearchParams(Object.entries((await req.json().catch(() => ({}))) as Record<string, string>).map(([k, v]) => [k, String(v)]));
    else p = new URLSearchParams(await req.text());
    let basic: { id: string; secret: string } | undefined;
    const auth = req.headers.get("Authorization");
    if (auth?.startsWith("Basic ")) {
      const [id, secret] = atob(auth.slice(6)).split(":").map((s) => decodeURIComponent(s));
      basic = { id, secret: secret ?? "" };
    }
    try {
      return json(await o.oauth.token(p, basic, origin), 200, OPEN);
    } catch (e) {
      if (e instanceof OAuthError) return oauthError(e);
      throw e;
    }
  }

  const metadata = (origin: string) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
  const resource = (origin: string) => ({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "corkboard node",
  });

  function caller(req: Request, origin: string): Caller | undefined {
    const auth = req.headers.get("Authorization");
    return auth?.startsWith("Bearer ") ? o.oauth.verify(auth.slice(7).trim(), origin) : undefined;
  }
  const unauthorized = (origin: string) =>
    new Response(JSON.stringify({ error: "invalid_token", error_description: "sign in to this node" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="assistant"` },
    });

  async function api(req: Request, path: string[], who: Caller): Promise<Response> {
    const { data, search } = o;
    const url = new URL(req.url);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const body = async () => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
    const m = req.method;
    const [what, name, sub, id, more] = path;
    const brainOf = (n: string) => {
      if (!data.replicas.get("brain", n)) throw new Invalid(`no brain ${n} on this node`);
      return n;
    };
    // The goals are the brains' own agents', not the user's clients'.
    const hidden = BRAIN_ONLY_KINDS;

    if (what === "status" && m === "GET" && !name) return json({ objects: data.replicas.status(), calendar: !!o.calendar?.(), default_brain: data.defaultBrain() ?? null });
    if (what === "boards") {
      if (!name && m === "GET")
        return json(
          data.boards().map((b) => {
            const cards = data.cards(b.key);
            return { key: b.key, cards: cards.map(({ log: _, ...c }) => ({ ...c, waiting_on: waitingOn(c, cards) })) };
          }),
        );
      if (!data.replicas.get("board", name)) return json({ error: `no board ${name} on this node` }, 404);
      if (sub === "cards" && !id && m === "GET") {
        const cards = data.cards(name, q("all") === "1");
        return json(cards.map((c) => (q("log") === "1" ? c : (({ log: _, ...rest }) => rest)(c))));
      }
      if (sub === "cards" && !id && m === "POST") return json(await data.createCard(name, await body()), 201);
      if (sub === "cards" && id && !more && m === "GET") return json(data.card(name, id.toUpperCase()));
      if (sub === "cards" && id && !more && m === "PATCH") {
        const { version: _, ...f } = await body();
        return json(await data.updateCard(name, id.toUpperCase(), f));
      }
      if (sub === "cards" && id && more === "log" && m === "POST") {
        const b = await body();
        if (typeof b.note !== "string") throw new Invalid("note must be a non-empty string");
        return json(await data.appendLog(name, id.toUpperCase(), typeof b.who === "string" && b.who.trim() ? b.who.trim().slice(0, 100) : "phone", b.note), 201);
      }
    }
    if (what === "brains") {
      if (!name && m === "GET") return json(data.brains().map((b) => ({ ...b, default: b.name === data.defaultBrain(), notes: data.notes(b.name).length, entries: data.entries(b.name).length })));
      const brain = brainOf(name);
      if (sub === "notes" && !id && m === "GET") return json(search.notes(brain, q("q"), q("kind"), Math.min(Number(q("limit")) || 20, 200), hidden));
      if (sub === "notes" && id && m === "GET") {
        const n = data.note(brain, noteId(id));
        return n && !hidden.includes(n.kind) ? json(n) : json({ error: `no note ${id}` }, 404);
      }
      if (sub === "notes" && id && m === "PUT") {
        const b = await body();
        const nid = noteId(id);
        if (nid === "soul" && who.scope !== "owner") return json({ error: "only the user writes the soul" }, 403);
        if (hidden.includes(b.kind)) throw new Invalid(`a ${b.kind} note isn't written here`);
        return json(await data.putNote(brain, nid, checkNote(b), b.version === undefined ? undefined : Number(b.version)));
      }
      if (sub === "recall" && m === "GET") return json(await search.recall(brain, q("q") ?? "", Math.min(Number(q("limit")) || 15, 50), hidden));
      if (sub === "entries" && m === "GET") {
        const from = q("from") ? checkDate(q("from")) : data.today();
        return json(data.entries(brain, from, q("to") ? checkDate(q("to")) : from));
      }
      if (sub === "remember" && m === "POST") {
        const b = await body();
        if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) throw new Invalid("text must be a line under 4000 characters");
        return json(await data.remember(brain, typeof b.who === "string" && b.who.trim() ? b.who.trim().slice(0, 100) : "phone", b.text), 201);
      }
    }
    if (what === "calendar" && !name && m === "POST") {
      if (who.scope !== "owner") return json({ error: "only the user's own clients write the calendar" }, 403);
      const c = o.calendar?.();
      if (!c) return json({ error: "the calendar isn't connected; corkboard-bridge serve calendar-login" }, 409);
      const b = await body();
      const plan = { date: checkDate(b.date), day: { blocks: Array.isArray(b.day?.blocks) ? b.day.blocks : [] } } as Pick<Plan, "date" | "day">;
      plan.day.blocks = checkBlocks(plan.day.blocks);
      try {
        return json({ blocks: await writePlan(c, plan, o.fetch) });
      } catch (e) {
        if (e instanceof CalendarError) return json({ error: e.message }, 502);
        throw e;
      }
    }
    return json({ error: "not found" }, 404);
  }

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const origin = originOf(req, o.origin);
    const p = url.pathname;
    try {
      if (p === "/health") return json({ ok: true });
      if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return json(resource(origin), 200, OPEN);
      if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/mcp") return json(metadata(origin), 200, OPEN);
      if (p === "/register") {
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...OPEN, "Access-Control-Allow-Headers": "Content-Type" } });
        if (req.method !== "POST") return new Response(null, { status: 405 });
        try {
          return json(o.oauth.register((await req.json().catch(() => ({}))) as Record<string, unknown>), 201, OPEN);
        } catch (e) {
          if (e instanceof OAuthError) return oauthError(e);
          throw e;
        }
      }
      if (p === "/authorize") return await authorize(req, origin);
      if (p === "/token") return await token(req, origin);
      if (p === "/mcp") {
        const who = caller(req, origin);
        if (!who) return unauthorized(origin);
        return await mcp(req, { data: o.data, search: o.search }, who);
      }
      if (p.startsWith("/api/node/")) {
        const who = caller(req, origin);
        if (!who) return unauthorized(origin);
        return await api(req, p.slice("/api/node/".length).split("/").filter(Boolean).map(decodeURIComponent), who);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof Invalid) return json({ error: e.message }, /^no (card|note|board|brain) /.test(e.message) ? 404 : 400);
      console.error(`node: ${req.method} ${p}:`, e);
      return json({ error: "the node failed" }, 500);
    }
  };
}
