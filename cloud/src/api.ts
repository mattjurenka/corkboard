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
//                                            { type: "chat", message } on every chat message
//   GET   /api/chat                          the chat with Pepper, oldest first: ?after=id, else the newest 100
//   POST  /api/chat                          { text }: the user says something to Pepper
//   GET   /api/notes                        ?q= to search, ?kind=, ?limit=
//   GET, PUT, DELETE /api/notes/:id          PUT { kind, title, body, path?, version? }
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
//   POST  /api/tokens/revoke                 { token }
//
// All of it needs the owner scope. /mcp (mcp.ts) is behind the same token
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
import type { Result } from "./board";
import { CARD_TOKEN, type Env, type Props } from "./index";
import { type Grant, brainOf, hiddenFor, mcp, memoryOf } from "./mcp";
import { blocks, chatText, date, note, noteId } from "./plans";
import { BRAINS, type Brain } from "./memory";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string, extra: object = {}) => json({ error: message, ...extra }, status);

function reply<T>(result: Result<T>, status = 200): Response {
  if (result.ok) return json(result.value, status);
  return error(result.status, result.error, result.card ? { card: result.card } : result.plan ? { plan: result.plan } : result.note ? { note: result.note } : {});
}

// A board key is a local project path with / as - (corkboard's path_key).
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

function boardInfo(key: string, input: Record<string, unknown>) {
  const { name = key, root = null, ...rest } = input;
  if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
  if (typeof name !== "string" || !name.trim()) throw new Invalid("name must be a non-empty string");
  if (root !== null && typeof root !== "string") throw new Invalid("root must be a path or null");
  return { key, name: name.trim(), root };
}

async function route(request: Request, env: Env, user: string): Promise<Response> {
  const m = new URL(request.url).pathname.match(ROUTE);
  if (!m) return error(404, "not found");
  const [, key, rawId, sub, live] = m;
  const method = request.method;
  const users = env.USER.get(env.USER.idFromName(user));

  if (key === undefined) {
    if (method !== "GET") return error(405, "method not allowed");
    return json(await users.boards());
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
    const info = boardInfo(key, await body(request));
    await board.describe(info.name, info.root);
    await users.remember(info);
    return json(info);
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
export const tokenKey = async (token: string) =>
  `card-token:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))}`;

async function mint(env: Env, props: Props, grant: NonNullable<Props["grant"]>): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = CARD_TOKEN + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const minted: Props = { userId: props.userId, email: props.email, grant };
  await env.OAUTH_KV.put(await tokenKey(token), JSON.stringify(minted), { expirationTtl: CARD_TOKEN_TTL });
  return json({ token, expires_at: new Date(Date.now() + CARD_TOKEN_TTL * 1000).toISOString() }, 201);
}

async function tokens(request: Request, env: Env, props: Props): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (path === "/api/tokens/revoke") {
    if (typeof input.token !== "string") throw new Invalid("token must be the token to revoke");
    await env.OAUTH_KV.delete(await tokenKey(input.token));
    return new Response(null, { status: 204 });
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

// Who's asking, for the MCP server: a card or Pepper token says; OAuth
// tokens by scope.
function grantOf(ctx: OAuthResourceContext<Props>): Grant | undefined {
  if (ctx.props.grant) return ctx.props.grant;
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
    // A card token is only for the MCP server.
    if (ctx.props.grant || !ctx.auth.scope.includes("owner")) return insufficientScope(ctx.auth, ["owner"]);
    try {
      if (path.startsWith("/api/tokens")) return await tokens(request, env, ctx.props);
      const users = env.USER.get(env.USER.idFromName(ctx.props.userId));
      if (path === "/api/live") return users.fetch(request);
      const brain = brainNamed(new URL(request.url).searchParams.get("brain") ?? "pepper");
      if (path.startsWith("/api/notes")) return await notes(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/memory/entries") return await importEntries(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/memory/vectors") return json(await (await memoryOf(env, ctx.props.userId, brain)).vectorState());
      if (path.startsWith("/api/plans/")) return await plans(request, users);
      if (path === "/api/chat") return await chat(request, users);
      return await route(request, env, ctx.props.userId);
    } catch (e) {
      if (e instanceof Invalid) return error(400, e.message);
      throw e;
    }
  },
};
