// The REST API, behind the OAuth provider: every request here carries a
// valid access token, and ctx.props says whose.
//
//   GET   /api/boards                        the user's boards
//   PUT   /api/boards/:board                 make or rename a board: { name, root? }
//   DELETE /api/boards/:board                the board and all its cards, for good
//   GET   /api/boards/:board/cards           the board, in order, with waiting_on; ?log=1 adds logs;
//                                            ?archived=1 lists the archived cards instead
//   GET   /api/boards/:board/live            WebSocket: a BoardEvent per write
//   POST  /api/boards/:board/cards           create: fields, title required
//   GET   /api/boards/:board/cards/:id       one card, with its log
//   PATCH /api/boards/:board/cards/:id       { version, ...fields }; 409 + the card on a stale version
//   DELETE /api/boards/:board/cards/:id      the card and its log, for good; its id is never reused
//   POST  /api/boards/:board/cards/:id/archive  { archived? }: off the board (default) or back on
//   POST  /api/boards/:board/cards/:id/log   { who, note }
//   POST  /api/boards/:board/cards/:id/lease { agent }: the agent is alive; { until } or null (board.ts's touch)
//   POST  /api/boards/:board/import          { cards: [...] } with their ids, times and logs; empty boards only
//   GET   /api/live                          WebSocket: { type: "plan", plan } on every plan change,
//                                            { type: "chat", message } on every chat message, and the
//                                            fleet's; ?bridge=<id>&machine= for a bridge's (user.ts)
//   GET   /api/chat                          the chat with Pepper, oldest first: ?after=id, else the newest 100
//   POST  /api/chat                          { text }: the user says something to Pepper
//   GET   /api/sessions                      each connected bridge, with its pages' Claude Code sessions
//   GET   /api/sessions/:bridge/:key         { lines }: what the session's terminal shows
//   POST  /api/sessions/:bridge/:key/say     { text?, keys? }: typed into it, the keys after the text
//   GET   /api/sessions/:bridge/:key/attach  WebSocket: its conversation as it goes (user.ts)
//   GET   /api/notes                        ?q= to search, ?kind=, ?limit=
//   GET, PUT, DELETE /api/notes/:id          PUT { kind, title, body, path?, version? }
//   GET   /api/goals                         the goal notes, read into their parts (goals.ts)
//   POST  /api/memory/entries                { entries: [{ day, at, who, text, key }] }: a log written
//                                            elsewhere, each entry added once
//   GET   /api/memory/vectors                { on, queued, embedded }: how far embedding has got
//                                            (notes and entries are Pepper's brain's, or ?brain='s)
//   GET, DELETE /api/plans/:date             the day and any proposal (an empty plan if none); gone for good
//   POST  /api/plans/:date/say               { text }: what to change, for the next proposal
//   POST  /api/plans/:date/accept            { version, blocks }: the proposal, as the user left it
//   POST  /api/plans/:date/discard           { version }
//   PUT   /api/plans/:date/day               { version, blocks }: the day, edited
//   POST  /api/tokens                        a card token for an agent: { board, card, agent }
//   POST  /api/tokens/pepper                 a token for Pepper's session: the goals, besides what assistant sees
//   POST  /api/tokens/brain                  { brain }: a token for another brain's agents, in its memory
//   POST  /api/tokens/machine                { environment }: a server's token, until revoked: this
//                                            API but tickets, export and import, and of the fleet
//                                            and sessions only that environment's
//   POST  /api/tokens/revoke                 { token }
//   /api/spawns, /api/fleet/environments     the fleet's queue (fleet.ts)
//   POST  /api/workspace/tickets             { bridge, board }: { url } that opens the board on that bridge's page
//   POST  /api/workspace/redeem              { bridge, ticket }: the bridge, for the board: { key, name, root, remotes }
//   /api/git                                 the user's Forgejo repositories, read-only (git.ts)
//   GET   /api/export                      the whole account, to move it to another Worker
//   POST  /api/import                      that export, into an account with no boards yet
//
// All of it needs the owner scope or a machine token. /mcp (mcp.ts) is behind the same token
// check, and takes owner and assistant tokens, card tokens and Pepper's.
//
// A brain's memory (memory.ts), for its sessions' hooks, with any token but
// a card's; the brain is the token's:
//   GET   /memory/context                    Markdown: what a session starts with; ?budget= characters
//   POST  /memory/episodes                   { session, trigger?, transcript }: a session's transcript
//   GET   /memory/episodes                   ?pending=1 for those not yet consolidated, ?limit=
//   GET   /memory/episodes/:id               { id, transcript }

import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { Invalid, cardId, fields, imported, logEntry } from "./cards";
import type { BoardInfo, Result } from "./board";
import type { Dump } from "./dump";
import { CARD_TOKEN, type Env, type Props } from "./index";
import { type Grant, brainOf, hiddenFor, mcp, memoryOf } from "./mcp";
import { blocks, chatText, date, note, noteId } from "./plans";
import { BRAINS, type Brain } from "./memory";
import { fleetRoutes } from "./fleet";
import { gitRoutes } from "./git";
import { goals } from "./goals";
import { type Answer, MACHINE_HEADER } from "./user";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string, extra: object = {}) => json({ error: message, ...extra }, status);

function reply<T>(result: Result<T>, status = 200): Response {
  if (result.ok) return json(result.value, status);
  return error(result.status, result.error, result.card ? { card: result.card } : result.plan ? { plan: result.plan } : result.note ? { note: result.note } : {});
}

// A board key is the local project path it was made at, with / as -
// (corkboard's path_key); clones elsewhere find it by its first commit.
const BOARD_KEY = /^[A-Za-z0-9._-]{1,128}$/;

const ROUTE = /^\/api\/boards(?:\/([^/]+)(?:\/cards(?:\/([^/]+)(?:\/(log|lease|archive))?)?|\/(live|import))?)?$/;

async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Invalid("body must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid("expected an object");
  return value as Record<string, unknown>;
}

// A name left out is the board's own, or its key when it's new. environment:
// the machine root is on (as its fleetd names it), for fleetd there to work
// in that clone. remotes: its project's git remotes, which another
// environment clones it from.
function boardInfo(key: string, input: Record<string, unknown>, had?: BoardInfo) {
  const { name = had?.name ?? key, root = null, commit = null, environment = null, remotes, ...rest } = input;
  if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
  if (typeof name !== "string" || !name.trim()) throw new Invalid("name must be a non-empty string");
  if (root !== null && typeof root !== "string") throw new Invalid("root must be a path or null");
  if (commit !== null && (typeof commit !== "string" || !COMMIT.test(commit))) throw new Invalid("commit must be a commit hash");
  if (environment !== null && typeof environment !== "string") throw new Invalid("environment must be a name");
  if (remotes !== undefined && !(Array.isArray(remotes) && remotes.length <= 8 && remotes.every((r) => typeof r === "string" && REMOTE.test(r))))
    throw new Invalid("remotes must be a list of up to 8 git URLs");
  return { info: { key, name: name.trim(), root, commit, remotes: remotes as string[] | undefined }, environment };
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A URL or scp-like address git clones from, not an option or a local path.
const REMOTE = /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)[^\s]{1,500}$/;

async function route(request: Request, env: Env, user: string): Promise<Response> {
  const m = new URL(request.url).pathname.match(ROUTE);
  if (!m) return error(404, "not found");
  const [, key, rawId, sub, live] = m;
  const method = request.method;
  const users = env.USER.get(env.USER.idFromName(user));

  if (key === undefined) {
    if (method !== "GET") return error(405, "method not allowed");
    return json(await users.boards(new URL(request.url).searchParams.get("commit") ?? undefined));
  }
  if (!BOARD_KEY.test(key)) return error(400, `bad board key ${key}`);
  const board = env.BOARD.get(env.BOARD.idFromName(`${user}/${key}`));
  const cards = m[0].includes("/cards");

  if (live === "live") return board.fetch(request);
  if (live === "import") {
    if (method !== "POST") return error(405, "method not allowed");
    const { cards: list } = await body(request);
    if (!Array.isArray(list)) throw new Invalid("cards must be a list");
    return reply(await board.import(list.map(imported)), 201);
  }
  if (!cards) {
    if (method === "DELETE") {
      await board.destroy();
      await users.forget(key);
      return new Response(null, { status: 204 });
    }
    if (method !== "PUT") return error(405, "method not allowed");
    const { info, environment } = boardInfo(key, await body(request), await users.board(key));
    await board.describe(info.name, info.root);
    await users.remember(info);
    if (environment && info.root) await users.place(key, environment, info.root);
    return json((await users.board(key)) ?? info);
  }
  if (!rawId) {
    if (method === "GET") {
      const params = new URL(request.url).searchParams;
      return reply(await board.list(params.get("log") === "1", params.get("archived") === "1"));
    }
    if (method === "POST") return reply(await board.create(fields(await body(request))), 201);
    return error(405, "method not allowed");
  }
  const id = cardId(rawId);
  if (sub === "log") {
    if (method !== "POST") return error(405, "method not allowed");
    const { who, note } = logEntry(await body(request));
    return reply(await board.appendLog(id, who, note), 201);
  }
  if (sub === "lease") {
    if (method !== "POST") return error(405, "method not allowed");
    const { agent } = await body(request);
    if (typeof agent !== "string" || !agent.trim()) throw new Invalid("agent must be the agent's name");
    return reply(await board.touch(id, agent.trim()));
  }
  if (sub === "archive") {
    if (method !== "POST") return error(405, "method not allowed");
    const { archived = true, ...rest } = await body(request);
    if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
    if (typeof archived !== "boolean") throw new Invalid("archived must be true or false");
    return reply(await board.archive(id, archived));
  }
  if (method === "GET") return reply(await board.get(id));
  if (method === "DELETE") {
    const r = await board.remove(id);
    return r.ok ? new Response(null, { status: 204 }) : reply(r);
  }
  if (method === "PATCH") {
    const { version, ...rest } = await body(request);
    if (!Number.isInteger(version)) return error(400, "version must be the integer version you read");
    return reply(await board.update(id, fields(rest), version as number));
  }
  return error(405, "method not allowed");
}

type Users = DurableObjectStub<import("./user").User>;
type Memories = DurableObjectStub<import("./memory").Memory>;

async function notes(request: Request, memory: Memories): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.match(/^\/api\/notes(?:\/([^/]+))?$/);
  if (!id) return error(404, "not found");
  if (!id[1]) {
    if (request.method !== "GET") return error(405, "method not allowed");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    return json(await memory.notes(url.searchParams.get("q") ?? undefined, url.searchParams.get("kind") ?? undefined, limit));
  }
  const key = noteId(id[1]);
  if (request.method === "GET") return reply(await memory.note(key));
  if (request.method === "PUT") {
    const input = await body(request);
    if (input.version !== undefined && (!Number.isInteger(input.version) || (input.version as number) < 0)) throw new Invalid("version must be the note's version");
    return reply(await memory.putNote(key, note(input), input.version as number | undefined));
  }
  if (request.method === "DELETE") {
    await memory.deleteNote(key);
    return new Response(null, { status: 204 });
  }
  return error(405, "method not allowed");
}

function brainNamed(v: unknown): Brain {
  if (!BRAINS.includes(v as Brain)) throw new Invalid(`brain must be one of ${BRAINS.join(", ")}`);
  return v as Brain;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A brain's log as written elsewhere (a vault's daily files, bridge/
// memory-sync.ts): entries with their own times and keys, added once each.
async function importEntries(request: Request, memory: Memories): Promise<Response> {
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (!Array.isArray(input.entries) || input.entries.length > 2000) throw new Invalid("entries must be a list of at most 2000");
  const entries = input.entries.map((e: any, i: number) => {
    if (typeof e?.day !== "string" || !DAY.test(e.day)) throw new Invalid(`entries[${i}].day must be YYYY-MM-DD`);
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) throw new Invalid(`entries[${i}].at must be a time`);
    if (typeof e.key !== "string" || !e.key || e.key.length > 200) throw new Invalid(`entries[${i}].key must be the entry's key`);
    if (typeof e.text !== "string" || !e.text.trim() || e.text.length > 20_000) throw new Invalid(`entries[${i}].text must be the entry, at most 20000 characters`);
    return { day: e.day, at: e.at, key: e.key, text: e.text.trim(), who: typeof e.who === "string" && e.who.trim() ? e.who.trim().slice(0, 80) : "import" };
  });
  return json({ added: await memory.addEntries(entries) });
}

// What a brain's hooks call (memory.ts), with any token but a card's: the
// context a session starts with, and the transcript it ends with.
async function memoryRoutes(request: Request, memory: Memories, grant: Grant): Promise<Response> {
  const url = new URL(request.url);
  const hide = hiddenFor(grant);
  if (url.pathname === "/memory/context" && request.method === "GET") {
    const budget = Math.min(Math.max(Number(url.searchParams.get("budget")) || 24_000, 1000), 200_000);
    return new Response(await memory.context(budget, hide), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  }
  if (url.pathname === "/memory/episodes") {
    if (request.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      return json(await memory.episodes(limit, url.searchParams.get("pending") === "1"));
    }
    if (request.method !== "POST") return error(405, "method not allowed");
    const input = await body(request);
    const session = typeof input.session === "string" ? input.session.trim() : "";
    if (!session || session.length > 200) throw new Invalid("session must be the session's id");
    if (typeof input.transcript !== "string" || !input.transcript) throw new Invalid("transcript must be the session's transcript");
    const trigger = typeof input.trigger === "string" && /^[a-z-]{1,40}$/.test(input.trigger) ? input.trigger : "end";
    const r = await memory.addEpisode({ session, agent: grant.agent, trigger, transcript: input.transcript });
    return r.ok ? json(r.value, r.value.added ? 201 : 200) : reply(r);
  }
  const one = url.pathname.match(/^\/memory\/episodes\/([0-9a-f]{32})$/);
  if (one && request.method === "GET") return reply(await memory.episode(one[1]));
  return error(404, "not found");
}

async function chat(request: Request, users: Users): Promise<Response> {
  if (request.method === "GET") {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new Invalid("after must be a message id");
    return json(await users.chat(after, 100));
  }
  if (request.method !== "POST") return error(405, "method not allowed");
  return json(await users.post("matt", chatText((await body(request)).text)), 201);
}

// The keys a session can be sent besides text (nvim/lua/corkboard/away.lua's).
const KEYS = ["enter", "esc", "up", "down", "tab", "shift-tab", "ctrl-c"];

// MACHINE_HEADER is set here only, never passed on from the client.
function asMachine(request: Request, machine: string | undefined): Request {
  const r = new Request(request);
  r.headers.delete(MACHINE_HEADER);
  if (machine) r.headers.set(MACHINE_HEADER, machine);
  return r;
}

// machine: a machine token's environment, whose bridges are the only ones
// it may watch or type into; the list it may see.
async function sessions(request: Request, users: Users, machine?: string): Promise<Response> {
  const m = new URL(request.url).pathname.match(/^\/api\/sessions(?:\/([\w-]{1,64})\/([\w.-]{1,64})(?:\/(say|attach))?)?$/);
  if (!m) return error(404, "not found");
  const [, bridge, key, say] = m;
  if (bridge && machine && (await users.bridges()).find((b) => b.id === bridge)?.environment !== machine)
    return error(403, `bridge ${bridge} isn't one of ${machine}'s`);
  if (say === "attach") return users.fetch(asMachine(request, machine));
  if (!bridge) return request.method === "GET" ? json(await users.bridges()) : error(405, "method not allowed");
  const at = { key };
  let r: Result<Answer>;
  if (!say) {
    if (request.method !== "GET") return error(405, "method not allowed");
    r = await users.ask(bridge, { type: "screen", ...at });
  } else {
    if (request.method !== "POST") return error(405, "method not allowed");
    const input = await body(request);
    const text = input.text ?? "";
    if (typeof text !== "string" || text.length > 20_000) throw new Invalid("text must be a string, under 20000 characters");
    const keys = input.keys ?? [];
    if (!Array.isArray(keys) || keys.length > 16 || keys.some((k) => !KEYS.includes(k))) throw new Invalid(`keys must be a list of ${KEYS.join(", ")}`);
    if (!text && !keys.length) throw new Invalid("say something: text, keys or both");
    r = await users.ask(bridge, { type: "say", ...at, text, keys });
  }
  return reply(r);
}

async function plans(request: Request, users: Users): Promise<Response> {
  const m = new URL(request.url).pathname.match(/^\/api\/plans\/([^/]+)(?:\/(say|accept|discard|day))?$/);
  if (!m) return error(404, "not found");
  const day = date(m[1]);
  const action = m[2];
  if (!action) {
    if (request.method === "GET") return json(await users.plan(day));
    if (request.method !== "DELETE") return error(405, "method not allowed");
    await users.deletePlan(day);
    return new Response(null, { status: 204 });
  }
  const input = await body(request);
  const version = () => {
    if (!Number.isInteger(input.version)) throw new Invalid("version must be the integer version you read");
    return input.version as number;
  };
  if (action === "day" ? request.method !== "PUT" : request.method !== "POST") return error(405, "method not allowed");
  switch (action) {
    case "say": {
      if (typeof input.text !== "string" || !input.text.trim()) throw new Invalid("text must say what to change");
      return reply(await users.say(day, input.text.trim()));
    }
    case "accept":
      return reply(await users.accept(day, version(), blocks(input.blocks)));
    case "discard":
      return reply(await users.discard(day, version()));
    default:
      return reply(await users.setDay(day, version(), blocks(input.blocks)));
  }
}

// Card tokens: random, kept only as their SHA-256, each good for one agent on
// one card until it's revoked or expires. Pepper's are the same, for Pepper's
// session: the one grant that sees the goals.
const CARD_TOKEN_TTL = 7 * 24 * 3600;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const tokenKey = async (token: string) => `card-token:${await sha256(token)}`;
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ttl null: until it's revoked (a machine's, which has no one to renew it).
async function mintToken(env: Env, props: Props, grant: NonNullable<Props["grant"]>, ttl: number | null = CARD_TOKEN_TTL) {
  const token = CARD_TOKEN + random();
  const minted: Props = { userId: props.userId, email: props.email, grant };
  await env.OAUTH_KV.put(await tokenKey(token), JSON.stringify(minted), ttl === null ? {} : { expirationTtl: ttl });
  return { token, expires_at: ttl === null ? null : new Date(Date.now() + ttl * 1000).toISOString() };
}

const mint = async (env: Env, props: Props, grant: NonNullable<Props["grant"]>) => json(await mintToken(env, props, grant), 201);

const ENVIRONMENT = /^[\w.-]{1,64}$/;

// machine: the environment, when a machine token asks. It mints and revokes
// the tokens its agents use, but no machine's.
async function tokens(request: Request, env: Env, props: Props, machine?: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (path === "/api/tokens/revoke") {
    if (typeof input.token !== "string") throw new Invalid("token must be the token to revoke");
    const key = await tokenKey(input.token);
    if (machine && (await env.OAUTH_KV.get<Props>(key, "json"))?.grant?.kind === "machine") return error(403, "only the owner revokes a machine's token");
    await env.OAUTH_KV.delete(key);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/tokens/machine") {
    if (machine) return error(403, "only the owner mints a machine's token");
    if (typeof input.environment !== "string" || !ENVIRONMENT.test(input.environment)) throw new Invalid("environment must be the machine's environment name");
    return json(await mintToken(env, props, { kind: "machine", environment: input.environment, agent: input.environment }, null), 201);
  }
  if (path === "/api/tokens/pepper") return mint(env, props, { kind: "pepper", agent: "pepper" });
  if (path === "/api/tokens/brain") {
    const brain = brainNamed(input.brain);
    if (brain === "pepper") throw new Invalid("Pepper's token is /api/tokens/pepper");
    return mint(env, props, { kind: "brain", brain, agent: brain });
  }
  if (path !== "/api/tokens") return error(404, "not found");
  const { board: key, card: rawCard, agent } = input;
  if (typeof key !== "string" || !BOARD_KEY.test(key)) throw new Invalid("board must be a board key");
  if (typeof rawCard !== "string") throw new Invalid("card must be a card id");
  if (typeof agent !== "string" || !agent.trim()) throw new Invalid("agent must be the agent's name");
  const card = cardId(rawCard);
  // The card must exist, on a board that does.
  const found = (await env.BOARD.get(env.BOARD.idFromName(`${props.userId}/${key}`)).get(card)) as Result<unknown>;
  if (!found.ok) return reply(found);
  return mint(env, props, { kind: "card", board: key, card, agent: agent.trim() });
}

// Opening a board on another machine's bridge, from the portal (../portal):
// a ticket for one board on one bridge, good once and for two minutes, which
// that bridge redeems (bridge/server.ts's /open) before it serves its page
// with its own token. The portal's token never leaves this origin.
const TICKET_TTL = 120;
type Ticket = { userId: string; bridge: string; board: string };

// A machine redeems tickets for its own bridges, and makes none: that's the
// portal's, signed in as the owner.
async function workspace(request: Request, env: Env, props: Props, users: Users, machine?: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (typeof input.bridge !== "string") throw new Invalid("bridge must be a bridge id");
  const bridge = (await users.bridges()).find((b) => b.id === input.bridge);
  if (machine && (path === "/api/workspace/tickets" || bridge?.environment !== machine)) return error(403, "not with a machine token");
  if (path === "/api/workspace/tickets") {
    const { board: key } = input;
    if (typeof key !== "string" || !BOARD_KEY.test(key)) throw new Invalid("board must be a board key");
    if (!(await users.board(key))) return error(404, `no board ${key}`);
    if (!bridge?.url) return error(404, `bridge ${input.bridge} isn't connected, or serves no page`);
    const ticket = random();
    await env.OAUTH_KV.put(`ticket:${await sha256(ticket)}`, JSON.stringify({ userId: props.userId, bridge: bridge.id, board: key } satisfies Ticket), {
      expirationTtl: TICKET_TTL,
    });
    return json({ url: `${bridge.url}/open?ticket=${ticket}` }, 201);
  }
  if (path === "/api/workspace/redeem") {
    if (typeof input.ticket !== "string") throw new Invalid("ticket must be the ticket");
    const at = `ticket:${await sha256(input.ticket)}`;
    const ticket = await env.OAUTH_KV.get<Ticket>(at, "json");
    if (!ticket || ticket.userId !== props.userId || ticket.bridge !== input.bridge) return error(403, "that ticket is used, expired, or for another bridge");
    await env.OAUTH_KV.delete(at);
    const board = await users.board(ticket.board);
    if (!board) return error(404, `no board ${ticket.board}`);
    // Its clone there, if that environment has one.
    const environment = bridge?.environment;
    const root = environment && board.environments?.includes(environment) ? await users.rootIn(board.key, environment) : null;
    return json({ key: board.key, name: board.name, root, remotes: board.remotes ?? [] });
  }
  return error(404, "not found");
}

// The whole account, to move it to a Worker on another Cloudflare account,
// where Durable Objects can't follow: the user's object, each board's and
// each brain's memory, table by table (dump.ts). The other Worker takes it
// only while it has no boards. Sign-ins don't move: every client signs in
// there again.
type Account = { version: 1; user: Dump; boards: Record<string, Dump>; memory: Partial<Record<Brain, Dump>> };

async function exportAccount(env: Env, userId: string, users: Users): Promise<Account> {
  const boards: Account["boards"] = {};
  for (const b of await users.boards()) boards[b.key] = await env.BOARD.get(env.BOARD.idFromName(`${userId}/${b.key}`)).dump();
  const memory: Account["memory"] = {};
  for (const brain of BRAINS) memory[brain] = await env.MEMORY.get(env.MEMORY.idFromName(`${userId}/${brain}`)).dump();
  return { version: 1, user: await users.dump(), boards, memory };
}

async function importAccount(env: Env, userId: string, users: Users, input: Record<string, unknown>): Promise<Response> {
  const a = input as Partial<Account>;
  if (a.version !== 1 || !a.user || typeof a.boards !== "object" || typeof a.memory !== "object") throw new Invalid("expected an export (GET /api/export)");
  const counts: Record<string, number> = {};
  const step = async (what: string, r: Result<number>) => {
    if (!r.ok) throw Object.assign(new Error(`${what}: ${r.error}`), { status: r.status, counts });
    counts[what] = r.value;
  };
  try {
    await step("user", await users.restore(a.user));
    for (const [key, d] of Object.entries(a.boards!)) {
      if (!BOARD_KEY.test(key)) throw new Invalid(`bad board key ${key}`);
      await step(`board ${key}`, await env.BOARD.get(env.BOARD.idFromName(`${userId}/${key}`)).restore(d));
    }
    for (const [brain, d] of Object.entries(a.memory!)) await step(`memory ${brainNamed(brain)}`, await env.MEMORY.get(env.MEMORY.idFromName(`${userId}/${brain}`)).restore(d!));
  } catch (e: any) {
    if (e instanceof Invalid) throw e;
    return error(e.status ?? 500, e.message, { restored: counts });
  }
  return json({ restored: counts }, 201);
}

// Who's asking, for the MCP server: a card or Pepper token says; OAuth
// tokens by scope.
function grantOf(ctx: OAuthResourceContext<Props>): Grant | undefined {
  if (ctx.props.grant) return ctx.props.grant.kind === "machine" ? undefined : ctx.props.grant;
  if (ctx.auth.scope.includes("owner")) return { kind: "owner", agent: "claude" };
  if (ctx.auth.scope.includes("assistant")) return { kind: "assistant", agent: "assistant" };
}

export const api = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      const grant = grantOf(ctx);
      if (!grant) return insufficientScope(ctx.auth, ["assistant"]);
      return mcp(request, env, ctx.props.userId, grant);
    }
    if (path.startsWith("/memory/")) {
      const grant = grantOf(ctx);
      const brain = grant && brainOf(grant);
      if (!grant || !brain) return insufficientScope(ctx.auth, ["assistant"]);
      try {
        return await memoryRoutes(request, await memoryOf(env, ctx.props.userId, brain), grant);
      } catch (e) {
        if (e instanceof Invalid) return error(400, e.message);
        throw e;
      }
    }
    // A card token is only for the MCP server. A machine's is the owner's
    // API less what reaches past its own environment.
    const machine = ctx.props.grant?.kind === "machine" ? ctx.props.grant.environment : undefined;
    if (!machine && (ctx.props.grant || !ctx.auth.scope.includes("owner"))) return insufficientScope(ctx.auth, ["owner"]);
    try {
      if (path.startsWith("/api/tokens")) return await tokens(request, env, ctx.props, machine);
      if (path.startsWith("/api/spawns") || path.startsWith("/api/fleet/")) return await fleetRoutes(request, env, ctx.props, () => body(request), mintToken, machine);
      const users = env.USER.get(env.USER.idFromName(ctx.props.userId));
      if (path === "/api/live") return users.fetch(asMachine(request, machine));
      const brain = brainNamed(new URL(request.url).searchParams.get("brain") ?? "pepper");
      if (path.startsWith("/api/notes")) return await notes(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/goals") {
        if (request.method !== "GET") return error(405, "method not allowed");
        return json(goals(await (await memoryOf(env, ctx.props.userId, brain)).goalNotes()));
      }
      if (path === "/api/memory/entries") return await importEntries(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/memory/vectors") return json(await (await memoryOf(env, ctx.props.userId, brain)).vectorState());
      if (path.startsWith("/api/plans/")) return await plans(request, users);
      if (path === "/api/chat") return await chat(request, users);
      if (path.startsWith("/api/sessions")) return await sessions(request, users, machine);
      if (path.startsWith("/api/workspace/")) return await workspace(request, env, ctx.props, users, machine);
      if (path === "/api/git" || path.startsWith("/api/git/")) return machine ? error(403, "not with a machine token") : await gitRoutes(request, env);
      if ((path === "/api/export" || path === "/api/import") && machine) return error(403, "not with a machine token");
      if (path === "/api/export") return request.method === "GET" ? json(await exportAccount(env, ctx.props.userId, users)) : error(405, "method not allowed");
      if (path === "/api/import") return request.method === "POST" ? await importAccount(env, ctx.props.userId, users, await body(request)) : error(405, "method not allowed");
      return await route(request, env, ctx.props.userId);
    } catch (e) {
      if (e instanceof Invalid) return error(400, e.message);
      throw e;
    }
  },
};
