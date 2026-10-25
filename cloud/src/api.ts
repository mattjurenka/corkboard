// The REST API, behind the OAuth provider: every request here carries a
// valid access token, and ctx.props says whose.
//
//   GET   /api/boards                        the user's boards
//   PUT   /api/boards/:board                 make or rename a board: { name, root? }
//   DELETE /api/boards/:board                the board and all its cards, for good
//   GET   /api/boards/:board/cards           the board, in order, with waiting_on; ?log=1 adds logs
//   GET   /api/boards/:board/live            WebSocket: a BoardEvent per write
//   POST  /api/boards/:board/cards           create: fields, title required
//   GET   /api/boards/:board/cards/:id       one card, with its log
//   PATCH /api/boards/:board/cards/:id       { version, ...fields }; 409 + the card on a stale version
//   POST  /api/boards/:board/cards/:id/log   { who, note }
//   POST  /api/boards/:board/import          { cards: [...] } with their ids, times and logs; empty boards only
//   POST  /api/tokens                        a card token for an agent: { board, card, agent }
//   POST  /api/tokens/revoke                 { token }
//
// All of it needs the owner scope. /mcp (mcp.ts) is behind the same token
// check, and takes owner and assistant tokens, and card tokens.

import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { Invalid, cardId, fields, imported, logEntry } from "./cards";
import type { Result } from "./board";
import { CARD_TOKEN, type Env, type Props } from "./index";
import { type Grant, mcp } from "./mcp";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string, extra: object = {}) => json({ error: message, ...extra }, status);

function reply<T>(result: Result<T>, status = 200): Response {
  if (result.ok) return json(result.value, status);
  return error(result.status, result.error, result.card ? { card: result.card } : {});
}

// A board key is a local project path with / as - (corkboard's path_key).
const BOARD_KEY = /^[A-Za-z0-9._-]{1,128}$/;

const ROUTE = /^\/api\/boards(?:\/([^/]+)(?:\/cards(?:\/([^/]+)(\/log)?)?|\/(live|import))?)?$/;

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
  const [, key, rawId, log, live] = m;
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
    if (method === "GET") return reply(await board.list(new URL(request.url).searchParams.get("log") === "1"));
    if (method === "POST") return reply(await board.create(fields(await body(request))), 201);
    return error(405, "method not allowed");
  }
  const id = cardId(rawId);
  if (log) {
    if (method !== "POST") return error(405, "method not allowed");
    const { who, note } = logEntry(await body(request));
    return reply(await board.appendLog(id, who, note), 201);
  }
  if (method === "GET") return reply(await board.get(id));
  if (method === "PATCH") {
    const { version, ...rest } = await body(request);
    if (!Number.isInteger(version)) return error(400, "version must be the integer version you read");
    return reply(await board.update(id, fields(rest), version as number));
  }
  return error(405, "method not allowed");
}

// Card tokens: random, kept only as their SHA-256, each good for one agent on
// one card until it's revoked or expires.
const CARD_TOKEN_TTL = 7 * 24 * 3600;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const tokenKey = async (token: string) =>
  `card-token:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))}`;

async function tokens(request: Request, env: Env, props: Props): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (path === "/api/tokens/revoke") {
    if (typeof input.token !== "string") throw new Invalid("token must be the token to revoke");
    await env.OAUTH_KV.delete(await tokenKey(input.token));
    return new Response(null, { status: 204 });
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
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = CARD_TOKEN + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const grant: Props = { userId: props.userId, email: props.email, grant: { kind: "card", board: key, card, agent: agent.trim() } };
  await env.OAUTH_KV.put(await tokenKey(token), JSON.stringify(grant), { expirationTtl: CARD_TOKEN_TTL });
  return json({ token, expires_at: new Date(Date.now() + CARD_TOKEN_TTL * 1000).toISOString() }, 201);
}

// Who's asking, for the MCP server: a card token says; OAuth tokens by scope.
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
    // A card token is only for the MCP server.
    if (ctx.props.grant || !ctx.auth.scope.includes("owner")) return insufficientScope(ctx.auth, ["owner"]);
    try {
      if (path.startsWith("/api/tokens")) return await tokens(request, env, ctx.props);
      return await route(request, env, ctx.props.userId);
    } catch (e) {
      if (e instanceof Invalid) return error(400, e.message);
      throw e;
    }
  },
};
