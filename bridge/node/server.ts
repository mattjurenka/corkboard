// What the node answers over HTTP. It listens on plain HTTP on this
// machine; TLS ends on this machine too, in Tailscale Funnel or Caddy in
// front of it (the plan's "Reachability").
//
//   GET  /health                       { ok }: no token, says nothing about the account
//   /.well-known/..., /register, /authorize, /token     oauth.ts
//   POST /mcp                          mcp.ts, with a token
//   PUT  /upload/:token                a file for attach_file's upload (media.ts); the token is the auth
//   /api/node/...                      the phone's API, with a token:
//     GET   status                     which objects are synced, and how far
//     GET   boards                     [{ key, name, root, roots, commit, remotes, cards: [summary] }]
//     GET   boards/:key                its settings (name, root, roots, commit, remotes)
//     PUT   boards/:key                { name?, remotes? }: the board made, or its settings changed (owner)
//     GET   boards/:key/cards          ?log=1 with their logs, ?all=1 archived too
//     POST  boards/:key/cards          fields: a new card
//     GET   boards/:key/cards/:id
//     PATCH boards/:key/cards/:id      fields
//     POST  boards/:key/cards/:id/log  { note, who? }
//     GET   boards/:key/cards/:id/media/:mid   a file on the card (media.ts)
//     GET   brains                     each brain's settings and counts
//     GET   brains/:name/notes         ?q=&kind=&limit=
//     GET   brains/:name/notes/:id
//     PUT   brains/:name/notes/:id     { kind, title, body, version? }
//     GET   brains/:name/recall        ?q=&limit=
//     GET   brains/:name/entries       ?from=&to=
//     POST  brains/:name/entries       { entries: [{ day, at, who, text, key }] }: a log written elsewhere
//                                      (memory-sync.ts's vault), each kept once: { added }
//     POST  brains/:name/remember      { text, who? }
//     GET   plans/:date                the day plan (day.ts)
//     POST  plans/:date/:change        say { text }, accept, discard or day { blocks, version?,
//                                      proposal? } (owner); a stale one is 409 with { error, plan }
//     GET   chat                       ?after=<id>&limit=: the messages, oldest first
//     POST  chat                       { text, who? }: the user's (owner), or the brain's
//     PATCH chat/:id, DELETE chat/:id  the user's own, until it's delivered (owner)
//     POST  chat/:id/delivered         passed on to Pepper (owner)
//     POST  grants                     { scope: card|session, board, card|spawn, agent }: a token held
//                                      to the board, for a fleet slot, and the /mcp it's for; or
//                                      { scope: brain, brain, agent }, a week's, for its memory hooks (owner)
//     DELETE grants                    { token }: that token ended (owner)
//   /memory/...                        a session's hooks, as the Worker's (fleet/memory-hooks.nix), with a
//                                      token; the brain is ?brain= (or the body's), else the default:
//     GET   context                    Markdown: what a session starts with; ?budget= characters
//     POST  episodes                   { session, trigger?, transcript }: a session's transcript (episodes.ts)
//     GET   episodes                   ?pending=1 for those not yet consolidated, ?limit=
//     GET   episodes/:id               { id, transcript }
//
// The origin (what tokens, metadata and redirects name) is --origin, or
// else the request's Host: https unless it's this machine.

import { BRAIN_ONLY_KINDS, blocks as checkBlocks, chatText, date as checkDate, note as checkNote, noteId } from "../../lib/model/plans";
import { waitingOn } from "../../lib/model/cards";
import { Conflict, type Data, Invalid } from "./data";
import { type Caller, type Consent, OAuthError, type OAuthStore, Redirect, SCOPES, boardBound, deniedUrl } from "./oauth";
import { type Fleet, mcp } from "./mcp";
import { Conflict as HoldConflict, type FleetRecords, SPAWN_ID } from "./fleet";
import type { Search } from "./search";
import type { CalendarConfig } from "./calendar";
import { type Episodes, TooBig } from "./episodes";
import type { Media } from "./media";
import type { DeviceCert, Signed } from "../../lib/e2ee/wire";
import type { Hub, Joined } from "../hub";
import type { Reach } from "../peers";

export type NodeOptions = {
  data: Data;
  search: Search;
  oauth: OAuthStore;
  episodes?: Episodes;
  media?: Media;
  // A board the node doesn't keep yet, kept from now on (serve.ts's).
  addBoard?: (key: string) => Promise<void>;
  origin?: string;
  // The calendar's config, for status: whether one is connected.
  calendar?: () => Promise<CalendarConfig | undefined> | CalendarConfig | undefined;
  // The Worker's fleet queue while this machine is signed in to it: /mcp's spawn tools.
  fleet?: () => Fleet | undefined;
  // What the fleet keeps sealed from the Worker (fleet.ts): /api/node/fleet.
  sealed?: FleetRecords;
  // The app's brains_*, nodes_*, notes and board_* operations (app.ts's),
  // and its boards' events, for another bridge on this machine while this
  // one's holds the node: loopback only.
  app?: () => AppCall | undefined;
  appEvents?: () => AppEvents | undefined;
  // This machine's sessions (hub.ts): its bridges join on loopback
  // (/app/sessions), and the account's devices watch them on a channel.
  hub?: Hub;
  // Every hub of the account's, the account's devices' on channels: for
  // this machine's bridges, on loopback (/app/peers, /app/peer/:device/...).
  reach?: Reach;
};

export type AppCall = (op: string, args: any[]) => Promise<unknown>;
// Called with each board event (lib/model/cards.ts's BoardEvent) as it
// happens; gives back the way to stop.
// key is null for a day event (a plan or the chat).
export type AppEvents = (fn: (key: string | null, event: unknown) => void) => () => void;
// The Worker's (cloud/src/api.ts's): a board's key, and a remote git clones from.
const BOARD_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const REMOTE = /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)[^\s]{1,500}$/;
const APP_OPS = /^(brains_\w+|nodes_\w+|note_get|note_put|goals|plan_(get|say|accept|discard|day)|board_(board|resolve|boards|snapshot|subscribe|make|create|update|log|archive|delete|touch))$/;

// What Bun.serve gives a fetch beside the request; a tunnel's and a test's
// don't, so they're never loopback.
type Peer = { requestIP(req: Request): { address: string } | null };
const loopback = (req: Request, peer?: Peer) => !!peer && /^(127\.|::1$|::ffff:127\.)/.test(peer.requestIP(req)?.address ?? "");

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

// Server-sent events, one per what follow sends, and a comment every 30s so
// the idle timeout doesn't end it. follow returns the way to stop.
function sse(follow: (send: (event: unknown) => void) => () => void): Response {
  let stop = () => {};
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      const send = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      const beat = setInterval(() => send(": beat\n\n"), 30_000);
      const off = follow((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      stop = () => (clearInterval(beat), off());
      send(": up\n\n");
    },
    cancel: () => stop(),
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

export function node(o: NodeOptions) {
  const consents = new Map<string, Consent>();
  // Each bridge's link to the hub, by its id: its /app/sessions/live.
  const joined = new Map<string, Joined>();

  const consentPage = (id: string, c: Consent, wrong = "") =>
    page(
      "connect",
      `<p>${escape(c.client.name)}</p>
<p class="muted">→ ${escape(new URL(c.redirect_uri).host || c.redirect_uri)}</p>
<p class="muted">${escape(c.scope)}</p>
${wrong ? `<p class="warn">${escape(wrong)}</p>` : ""}
<form method="post" action="authorize">
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

  // One held to a board (a card's agent, a fleet session) is only /mcp's.
  // On a sealed channel with no bearer, the device at its other end, whose
  // cert the channel checked: the account's own, so the owner.
  function caller(req: Request, origin: string, from: Signed<DeviceCert> | undefined, mcp = false): Caller | undefined {
    const auth = req.headers.get("Authorization");
    if (!auth && from) return { scope: "owner", agent: from.body.name, grant: `device:${from.body.device}`, resource: null };
    const who = auth?.startsWith("Bearer ") ? o.oauth.verify(auth.slice(7).trim(), origin) : undefined;
    return who && (mcp || !boardBound(who)) ? who : undefined;
  }
  const unauthorized = (origin: string) =>
    new Response(JSON.stringify({ error: "invalid_token", error_description: "sign in to this node" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="assistant"` },
    });

  // sealed: it came on a channel or on loopback, never the plaintext tunnel.
  async function api(req: Request, path: string[], who: Caller, origin: string, sealed: boolean): Promise<Response> {
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
    const hidden = who.brain && who.brain === name ? [] : BRAIN_ONLY_KINDS;

    if (what === "status" && m === "GET" && !name) return json({ objects: data.replicas.status(), calendar: !!(await Promise.resolve(o.calendar?.()).catch(() => undefined)), default_brain: data.defaultBrain() ?? null });
    if (what === "boards") {
      if (!name && m === "GET")
        return json(
          data.boards().map((b) => {
            const cards = data.cards(b.key);
            return { key: b.key, ...data.board(b.key), name: b.name, cards: cards.map(({ log: _, ...c }) => ({ ...c, waiting_on: waitingOn(c, cards) })) };
          }),
        );
      if (name && !sub && m === "PUT") {
        if (who.scope !== "owner") return json({ error: "only the user's own clients make boards" }, 403);
        if (!BOARD_KEY.test(name)) throw new Invalid(`bad board key ${name}`);
        const { name: title, remotes, ...rest } = await body();
        if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
        if (title !== undefined && (typeof title !== "string" || !title.trim())) throw new Invalid("name must be a non-empty string");
        if (remotes !== undefined && !(Array.isArray(remotes) && remotes.length <= 8 && remotes.every((r) => typeof r === "string" && REMOTE.test(r))))
          throw new Invalid("remotes must be a list of up to 8 git URLs");
        const made = !data.replicas.get("board", name);
        if (made) {
          if (!o.addBoard) return json({ error: "this node doesn't make boards" }, 501);
          await o.addBoard(name);
        }
        const had = data.board(name);
        await data.putBoard(name, { ...((title || had.name === undefined) && { name: title?.trim() || name }), ...(remotes && { remotes }) });
        return json({ key: name, ...data.board(name) }, made ? 201 : 200);
      }
      if (!data.replicas.get("board", name)) return json({ error: `no board ${name} on this node` }, 404);
      if (!sub && m === "GET") return json({ key: name, ...data.board(name) });
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
      if (sub === "cards" && id && more === "media" && path[5] && !path[6] && m === "GET")
        return o.media?.serve(name, id.toUpperCase(), path[5]) ?? json({ error: `no file ${path[5]} on ${id}` }, 404);
    }
    if (what === "grants" && !name) {
      if (who.scope !== "owner") return json({ error: "only the user's own clients hand out grants" }, 403);
      const b = await body();
      if (m === "DELETE") return json({ revoked: typeof b.token === "string" && o.oauth.revokeToken(b.token) });
      if (m !== "POST") return json({ error: "not found" }, 404);
      const str = (k: string) => {
        if (typeof b[k] !== "string" || !b[k].trim()) throw new Invalid(`${k} must be a non-empty string`);
        return b[k].trim() as string;
      };
      if (b.scope === "brain") {
        const brain = brainOf(str("brain"));
        const token = o.oauth.mint(`${str("agent")} for ${brain}`, 7, "assistant", brain);
        return json({ token, url: origin }, 201);
      }
      const board = str("board");
      if (!data.replicas.get("board", board)) return json({ error: `no board ${board} on this node` }, 404);
      const grant =
        b.scope === "card"
          ? o.oauth.mintBound({ scope: "card", board, card: data.card(board, str("card").toUpperCase()).id, agent: str("agent") })
          : b.scope === "session"
            ? o.oauth.mintBound({ scope: "session", board, spawn: str("spawn"), agent: str("agent") })
            : undefined;
      if (!grant) throw new Invalid("scope must be card or session");
      return json({ ...grant, url: `${origin}/mcp` }, 201);
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
      if (sub === "entries" && m === "POST") {
        const b = await body();
        if (!Array.isArray(b.entries) || b.entries.length > 2000) throw new Invalid("entries must be a list of at most 2000");
        const list = b.entries.map((e: any, i: number) => {
          if (typeof e?.at !== "string" || Number.isNaN(Date.parse(e.at))) throw new Invalid(`entries[${i}].at must be a time`);
          if (typeof e.key !== "string" || !e.key || e.key.length > 200) throw new Invalid(`entries[${i}].key must be the entry's key`);
          if (typeof e.text !== "string" || !e.text.trim() || e.text.length > 20_000) throw new Invalid(`entries[${i}].text must be the entry, at most 20000 characters`);
          return { from: `key:${e.key}`, at: e.at, day: checkDate(e.day), text: e.text.trim(), who: typeof e.who === "string" && e.who.trim() ? e.who.trim().slice(0, 80) : "import" };
        });
        // The same text at the same time is the same entry, as the Worker's
        // were when they moved here (move.ts's, without their keys).
        const have = new Set(data.entries(brain).map((e) => `${Date.parse(e.at)}\n${e.text}`));
        return json({ added: await data.importEntries(brain, list.filter((e: { at: string; text: string }) => !have.has(`${Date.parse(e.at)}\n${e.text}`))) });
      }
      if (sub === "remember" && m === "POST") {
        const b = await body();
        if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) throw new Invalid("text must be a line under 4000 characters");
        return json(await data.remember(brain, typeof b.who === "string" && b.who.trim() ? b.who.trim().slice(0, 100) : "phone", b.text), 201);
      }
    }
    // Day plans and the chat (day.ts). Only the user's own clients accept,
    // discard or edit a day, so no agent accepts a plan for itself.
    if (what === "plans" && name) {
      const d = checkDate(name);
      if (m === "GET" && !sub) return json(data.plan(d));
      if (m === "POST" && sub) {
        if (who.scope !== "owner") return json({ error: "only the user's own clients change a plan" }, 403);
        const b = await body();
        const version = Number.isInteger(b.version) ? (b.version as number) : null;
        const proposal = typeof b.proposal === "string" ? b.proposal : undefined;
        if (sub === "say") return json(await data.say(d, typeof b.who === "string" && b.who.trim() ? b.who.trim().slice(0, 100) : "me", chatText(b.text)));
        if (sub === "accept") return json(await data.accept(d, version, checkBlocks(b.blocks), proposal));
        if (sub === "discard") return json(await data.discard(d, version, proposal));
        if (sub === "day") return json(await data.setDay(d, version, checkBlocks(b.blocks)));
      }
    }
    // Each change to the day object, as an event with nothing in it: pepperd
    // reads the chat after one (fleet/fleetd/assistant.ts), not every ten seconds.
    if (what === "day" && name === "events" && m === "GET") return sse((send) => data.replicas.onChange((x) => x.kind === "day" && send({ kind: "day" })));
    if (what === "chat") {
      if (!name && m === "GET") return json(data.chat(q("after"), Math.min(Number(q("limit")) || 100, 500)));
      // The user's own from the owner's clients; else the brain's.
      if (!name && m === "POST") {
        const b = await body();
        const mine = who.scope === "owner";
        const by = mine ? (typeof b.who === "string" && b.who.trim() ? b.who.trim().slice(0, 100) : "me") : (who.brain ?? "assistant");
        return json(await data.post(by, chatText(b.text), mine), 201);
      }
      if (name && who.scope !== "owner") return json({ error: "only the user's own clients change a message" }, 403);
      if (name && !sub && m === "PATCH") return json(await data.edit(name, chatText((await body()).text)));
      if (name && !sub && m === "DELETE") return (await data.unsay(name), new Response(null, { status: 204 }));
      if (name && sub === "delivered" && m === "POST") return json(await data.deliver(name));
    }
    // The fleet's sealed part (fleet.ts): the user's own clients and fleetd's
    // device, never an agent's grant, and only on a channel or loopback.
    if (what === "fleet" && o.sealed?.has()) {
      if (who.scope !== "owner" || !sealed) return json({ error: "not found" }, 404);
      const f = o.sealed;
      try {
        if (name === "spawns" && !sub && m === "POST") return json(await f.queue(await body()), 201);
        if (name === "spawns" && sub && SPAWN_ID.test(sub)) {
          const s = f.spawn(sub);
          if (m === "GET") {
            if (!s) return json({ error: `no spawn ${sub} here` }, 404);
            const holds = q("holds")?.split(",").filter(Boolean) ?? [];
            return json({ ...s, ...(holds.length && { secrets: f.secrets(holds) }) });
          }
          if (m === "PUT") return json(await f.report(sub, await body()));
        }
        if (name === "environments" && !sub && m === "GET") return json(f.environments());
        if (name === "environments" && sub && m === "PUT") return (await f.putEnvironment(sub, (await body()).manifest), json({}));
        if (name === "holds" && !id) {
          const r = await f.holdRoute(m, sub, body);
          return r.status === 204 ? new Response(null, { status: 204 }) : json(r.body, r.status);
        }
      } catch (e) {
        if (e instanceof HoldConflict) return json({ error: e.message, ...(e.hold && { hold: e.hold }) }, 409);
        throw e;
      }
    }
    return json({ error: "not found" }, 404);
  }

  async function memory(req: Request, path: string[], who: Caller): Promise<Response> {
    const url = new URL(req.url);
    const m = req.method;
    const b = m === "POST" ? (((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>) : {};
    const asked = url.searchParams.get("brain") ?? (typeof b.brain === "string" ? b.brain : undefined);
    if (who.brain && asked && asked !== who.brain) return json({ error: `this token is brain ${who.brain}'s` }, 403);
    const brain = who.brain ?? asked ?? o.data.defaultBrain();
    if (!brain || !o.data.replicas.get("brain", brain)) return json({ error: asked ? `no brain ${asked} on this node` : "no brain on this node to remember in" }, 404);
    const [what, id] = path;
    if (what === "context" && !id && m === "GET") {
      const budget = Math.min(Math.max(Number(url.searchParams.get("budget")) || 24_000, 1000), 200_000);
      return new Response(o.search.context(brain, budget, who.brain ? [] : BRAIN_ONLY_KINDS), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const episodes = o.episodes;
    if (what !== "episodes" || !episodes) return json({ error: "not found" }, 404);
    if (!id && m === "GET") return json(episodes.list(brain, Math.min(Number(url.searchParams.get("limit")) || 50, 200), url.searchParams.get("pending") === "1"));
    if (!id && m === "POST") {
      const session = typeof b.session === "string" ? b.session.trim() : "";
      if (!session || session.length > 200) throw new Invalid("session must be the session's id");
      if (typeof b.transcript !== "string" || !b.transcript) throw new Invalid("transcript must be the session's transcript");
      const trigger = typeof b.trigger === "string" && /^[a-z-]{1,40}$/.test(b.trigger) ? b.trigger : "end";
      try {
        const r = episodes.add(brain, { session, agent: who.agent, trigger, transcript: b.transcript });
        return json(r, r.added ? 201 : 200);
      } catch (e) {
        if (e instanceof TooBig) return json({ error: e.message }, 413);
        throw e;
      }
    }
    if (id && m === "GET") {
      const transcript = /^[0-9a-f]{32}$/.test(id) ? episodes.transcript(brain, id) : undefined;
      return transcript === undefined ? json({ error: `no episode ${id}` }, 404) : json({ id, transcript });
    }
    return json({ error: "not found" }, 404);
  }

  // from: the device a sealed channel's request came from (serve.ts's).
  return async function fetch(req: Request, peer?: Peer, from?: Signed<DeviceCert>): Promise<Response> {
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
        const who = caller(req, origin, from, true);
        if (!who) return unauthorized(origin);
        return await mcp(req, { data: o.data, search: o.search, media: o.media, origin, fleet: o.fleet?.(), sealed: o.sealed }, who);
      }
      if (p.startsWith("/upload/")) {
        if (!o.media) return json({ error: "not found" }, 404);
        return await o.media.upload(req, p.slice("/upload/".length));
      }
      if (p === "/api/sessions" || p.startsWith("/api/sessions/")) {
        // Sealed, never the tunnel's: on a channel, from a device that's
        // more than a relay-only one, or on loopback.
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        if (!o.hub || who.scope !== "owner" || !(from ? from.body.role === undefined : loopback(req, peer))) return json({ error: "not found" }, 404);
        return (await o.hub.serve(req)) ?? json({ error: "not found" }, 404);
      }
      if (p === "/app/sessions/live" || p === "/app/sessions") {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        const hub = o.hub;
        if (!hub || who.scope !== "owner" || !loopback(req, peer)) return json({ error: "not found" }, 404);
        const q = new URL(req.url).searchParams;
        const id = q.get("bridge") ?? "";
        // A bridge's link: what the hub says to it, as events, while it
        // follows; what it says, POSTed as a list.
        if (p === "/app/sessions/live") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          if (!/^[\w-]{1,64}$/.test(id)) throw new Invalid("bad bridge id");
          return sse((send) => {
            const j = hub.join({ id, machine: q.get("machine") ?? "", url: q.get("url"), environment: q.get("environment") }, send);
            joined.set(id, j);
            return () => {
              j.drop();
              if (joined.get(id) === j) joined.delete(id);
            };
          });
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const j = joined.get(id);
        if (!j) return json({ error: `bridge ${id} isn't joined` }, 404);
        const said = await req.json().catch(() => null);
        for (const m of Array.isArray(said) ? said : []) j.receive(m);
        return json({});
      }
      if (p === "/app/peers" || p.startsWith("/app/peer/")) {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        const reach = o.reach;
        if (!reach || who.scope !== "owner" || !loopback(req, peer)) return json({ error: "not found" }, 404);
        if (p === "/app/peers") return json(await reach.devices());
        // A device's own path, as its hub serves it, the body as it comes.
        const [, device, rest] = p.match(/^\/app\/peer\/([\w-]{1,128})(\/api\/sessions(?:\/.*)?)$/) ?? [];
        if (!device) return json({ error: "not found" }, 404);
        const type = req.headers.get("content-type");
        const hasBody = !/^(GET|HEAD)$/i.test(req.method);
        return await reach.fetch(device, rest + new URL(req.url).search, { method: req.method, headers: type ? { "content-type": type } : {}, ...(hasBody && { body: req.body }), signal: req.signal });
      }
      if (p === "/app/events") {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        const events = o.appEvents?.();
        if (!events || who.scope !== "owner" || req.method !== "GET" || !loopback(req, peer)) return json({ error: "not found" }, 404);
        return sse((send) => events((key, event) => send({ key, event })));
      }
      if (p === "/app") {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        const call = o.app?.();
        if (!call || who.scope !== "owner" || req.method !== "POST" || !loopback(req, peer)) return json({ error: "not found" }, 404);
        const { op, args } = ((await req.json().catch(() => ({}))) ?? {}) as { op?: unknown; args?: unknown };
        if (typeof op !== "string" || !APP_OPS.test(op)) throw new Invalid(`no operation ${op}`);
        // undefined (the Worker's to answer) has no JSON: it's no value.
        const value = await call(op, Array.isArray(args) ? args : []);
        return json(value === undefined ? {} : { value });
      }
      if (p.startsWith("/api/node/")) {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        return await api(req, p.slice("/api/node/".length).split("/").filter(Boolean).map(decodeURIComponent), who, origin, !!from || loopback(req, peer));
      }
      if (p.startsWith("/memory/")) {
        const who = caller(req, origin, from);
        if (!who) return unauthorized(origin);
        return await memory(req, p.slice("/memory/".length).split("/").filter(Boolean).map(decodeURIComponent), who);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof Conflict) return json({ error: e.message, ...(e.plan ? { plan: e.plan } : {}) }, 409);
      if (e instanceof Invalid) return json({ error: e.message }, /^no (card|note|board|brain|message|day) /.test(e.message) ? 404 : 400);
      console.error(`node: ${req.method} ${p}:`, e);
      return json({ error: "the node failed" }, 500);
    }
  };
}
