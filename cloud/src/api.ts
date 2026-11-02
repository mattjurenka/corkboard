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
//   GET   /api/boards/:board/cards/:id/media/:mid  a file attached to the card (media.ts)
//   POST  /api/boards/:board/import          { cards: [...] } with their ids, times and logs; empty boards only
//   GET   /api/live                          WebSocket: { type: "plan", plan } on every plan change,
//                                            { type: "chat", message } on every chat message, and the
//                                            fleet's; ?bridge=<id>&machine= for a bridge's (user.ts)
//   GET   /api/chat                          the chat with Pepper, oldest first: ?after=id, else the newest 100
//   POST  /api/chat                          { text }: the user says something to Pepper
//   PATCH, DELETE /api/chat/:id              { text }: change or take back one of theirs Pepper doesn't have yet
//   POST  /api/chat/:id/delivered            pepperd passed it on to Pepper: its text as it is now
//   GET   /api/sessions                      each connected bridge, with its pages' Claude Code sessions
//   GET   /api/sessions/:bridge/:key         { lines }: what the session's terminal shows
//   POST  /api/sessions/:bridge/:key/say     { text?, keys? }: typed into it, the keys after the text
//   GET   /api/sessions/:bridge/:key/attach  WebSocket: its conversation as it goes (user.ts);
//                                            ?terminal for its terminal, both ways
//   GET   /api/notes                        ?q= to search, ?kind=, ?limit=
//   GET, PUT, DELETE /api/notes/:id          PUT { kind, title, body, path?, version? }
//   GET   /api/goals                         the goal notes, read into their parts (goals.ts)
//   POST  /api/memory/entries                { entries: [{ day, at, who, text, key }] }: a log written
//                                            elsewhere, each entry added once
//   GET   /api/memory/entries                ?day=, or ?from=&to=: the log, oldest first
//   GET   /api/memory/days                   the days the log has, newest first, with their counts
//   GET   /api/memory/episodes               the sessions' transcripts, newest first: ?pending=1, ?limit=
//   GET   /api/memory/episodes/:id           { id, transcript }
//   GET   /api/memory/recall                 ?q=: notes and entries about it, best first
//   GET   /api/memory/vectors                { on, queued, embedded }: how far embedding has got
//                                            (notes and entries are the default brain's, or ?brain='s)
//   GET, DELETE /api/plans/:date             the day and any proposal (an empty plan if none); gone for good
//   POST  /api/plans/:date/say               { text }: what to change, for the next proposal
//   POST  /api/plans/:date/accept            { version, blocks }: the proposal, as the user left it;
//                                            the Claude calendar is written after (calendar.ts)
//   POST  /api/plans/:date/discard           { version }
//   PUT   /api/plans/:date/day               { version, blocks }: the day, edited
//   POST  /api/tokens                        a card token for an agent: { board, card, agent }
//   POST  /api/tokens/pepper                 old: /api/brains/pepper/tokens, until the droplet's pepperd is
//                                            on that (fleet/pepper/pepperd.ts); then this and the next go
//   POST  /api/tokens/brain                  old: { brain }, as /api/brains/:brain/tokens
//   /api/brains                              brains, as data (brains.ts)
//   /api/holds                               what they hold, and its secrets (holds.ts)
//   POST  /api/tokens/machine                { environment, label?, expires_in? }: a server's token,
//                                            until revoked or expires_in seconds: this API but
//                                            tickets, export and import, of brains only their
//                                            tokens, and of the fleet and sessions only that
//                                            environment's
//   GET   /api/tokens/machine                the machine tokens: { id, environment, label, created,
//                                            expires, used }, never the token
//   DELETE /api/tokens/machine/:id           revoke one
//   POST  /api/tokens/revoke                 { token }
//   GET   /api/grants                        the OAuth clients signed in as you: { id, client, scope, created }
//   DELETE /api/grants/:id                   sign one out: its tokens stop working
//   DELETE /api/bridges/:id                  close a bridge's socket (its token is its grant's or machine's)
//   GET   /api/me                            { sub, email, name, role, settings, features }
//   PATCH /api/me                            { name?, timezone?, calendar? }: the user's settings (user.ts)
//   /api/admin                               accounts and invites, for admins (registry.ts)
//   /api/spawns, /api/fleet/environments     the fleet's queue (fleet.ts)
//   POST  /api/workspace/tickets             { bridge, board }: { url } that opens the board on that bridge's page
//   POST  /api/workspace/redeem              { bridge, ticket }: the bridge, for the board: { key, name, root, remotes }
//   /api/git                                 the first admin's Forgejo repositories, read-only, for
//                                            admins (git.ts)
//   POST  /api/e2ee/accounts               an end-to-end encrypted account, made by an admin with no invite (e2ee.ts)
//   GET   /api/export                      the whole account, to move it to another Worker
//   POST  /api/import                      that export, into an account with no boards yet
//
// All of it needs the owner scope or a machine token. /mcp (mcp.ts) is behind the same token
// check, and takes owner and assistant tokens, card tokens and Pepper's. Every token, of
// whatever kind, works only while its account is active in the registry (registry.ts).
//
// A brain's memory (memory.ts), for its sessions' hooks, with any token but
// a card's; the brain is the token's:
//   GET   /memory/context                    Markdown: what a session starts with; ?budget= characters
//   POST  /memory/episodes                   { session, trigger?, transcript }: a session's transcript
//   GET   /memory/episodes                   ?pending=1 for those not yet consolidated, ?limit=
//   GET   /memory/episodes/:id               { id, transcript }
//   GET   /memory/consolidate                the consolidator's next job: { episodes: [{ id, prompt, input }],
//                                            rollup: { through, version, prompt, input } | null }
//   POST  /memory/consolidate/episodes/:id   { text }: an episode's answer, as log entries
//   POST  /memory/consolidate/rollup         { through, version, text }: the long-term memory rewritten

import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { Invalid, cardId, fields, imported, logEntry } from "../../lib/model/cards";
import type { BoardInfo, Result } from "./board";
import type { Dump } from "./dump";
import { CARD_TOKEN, type Env, type Props } from "./index";
import { type Grant, brainOf, hiddenFor, mcp, memoryOf } from "./mcp";
import { calendarError, write as writeCalendar } from "./calendar";
import { type Plan, blocks, chatText, date, note, noteId, today } from "../../lib/model/plans";
import { NAME as BRAIN_NAME, brainRoutes, live } from "./brains";
import { dumpHolds, holdRoutes, restoreHolds, type HoldsDump } from "./holds";
import { fleetRoutes } from "./fleet";
import { MEDIA_ID, forget, mediaKey, serve } from "./media";
import { gitRoutes } from "./git";
import { createAccount } from "./e2ee";
import { goals } from "./goals";
import { type Account as Registered, accountOf, adminRoutes } from "./registry";
import { type Answer, MACHINE_HEADER, type Settings, zone } from "./user";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string, extra: object = {}) => json({ error: message, ...extra }, status);

function reply<T>(result: Result<T>, status = 200): Response {
  if (result.ok) return json(result.value, status);
  return error(result.status, result.error, result.card ? { card: result.card } : result.plan ? { plan: result.plan } : result.note ? { note: result.note } : {});
}

// A board key is the local project path it was made at, with / as -
// (corkboard's path_key); clones elsewhere find it by its first commit.
const BOARD_KEY = /^[A-Za-z0-9._-]{1,128}$/;

const ROUTE = /^\/api\/boards(?:\/([^/]+)(?:\/cards(?:\/([^/]+)(?:\/(log|lease|archive)|\/media\/([^/]+))?)?|\/(live|import))?)?$/;

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
  const [, key, rawId, sub, mediaId, live] = m;
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
      await forget(env, `${user}/${key}/`);
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
  if (mediaId !== undefined) {
    if (method !== "GET") return error(405, "method not allowed");
    if (!MEDIA_ID.test(mediaId)) return error(404, `no file ${mediaId} on ${id}`);
    return serve(env, user, key, id, mediaId);
  }
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
    if (r.ok) await forget(env, mediaKey(user, key, id));
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

// A brain there is and isn't archived, by name, or the default one.
async function brainNamed(env: Env, user: string, v: string | null): Promise<string> {
  const b = v === null ? await env.USER.get(env.USER.idFromName(user)).defaultBrain() : await live(env, user, v);
  if (!b) throw new Invalid(v === null ? "there's no default brain; say which with ?brain=" : `no brain ${v}`);
  return b.name;
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

// A brain's memory as the owner reads it (the brains view): its log by day,
// its episodes, and recall over it. Nothing is hidden from the owner.
async function browse(request: Request, memory: Memories): Promise<Response> {
  if (request.method !== "GET") return error(405, "method not allowed");
  const url = new URL(request.url);
  const limit = (fallback: number, max: number) => Math.min(Number(url.searchParams.get("limit")) || fallback, max);
  if (url.pathname === "/api/memory/days") return json(await memory.days(limit(60, 400)));
  if (url.pathname === "/api/memory/entries") {
    const from = url.searchParams.get("from") ?? url.searchParams.get("day");
    const to = url.searchParams.get("to") ?? from;
    if (!from || !DAY.test(from) || !to || !DAY.test(to)) throw new Invalid("day, or from and to, must be YYYY-MM-DD");
    if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw new Invalid("at most 92 days at once");
    return json(await memory.entries(from, to));
  }
  if (url.pathname === "/api/memory/episodes") return json(await memory.episodes(limit(50, 200), url.searchParams.get("pending") === "1"));
  const one = url.pathname.match(/^\/api\/memory\/episodes\/([0-9a-f]{32})$/);
  if (one) return reply(await memory.episode(one[1]));
  if (url.pathname === "/api/memory/recall") {
    const q = url.searchParams.get("q")?.trim();
    if (!q) throw new Invalid("q must say what to recall");
    return json(await memory.recall(q, limit(20, 50)));
  }
  return error(404, "not found");
}

// What a brain's hooks call (memory.ts), with any token but a card's: the
// context a session starts with, and the transcript it ends with; and the
// consolidator's, which runs as the brain (fleet/guest/slot.nix).
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
  if (url.pathname === "/memory/consolidate" && request.method === "GET") return json(await memory.consolidation());
  const answer = url.pathname.match(/^\/memory\/consolidate\/episodes\/([0-9a-f]{32})$/);
  if (answer && request.method === "POST") {
    const { text } = await body(request);
    if (typeof text !== "string") throw new Invalid("text must be the flush's answer");
    return reply(await memory.consolidated(answer[1], text));
  }
  if (url.pathname === "/memory/consolidate/rollup" && request.method === "POST") {
    const { through, version, text } = await body(request);
    if (typeof through !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new Invalid("through must be the rollup's last day");
    if (!Number.isInteger(version) || (version as number) < 0) throw new Invalid("version must be the memory's version the rollup was given");
    if (typeof text !== "string") throw new Invalid("text must be the rollup's answer");
    return reply(await memory.rolledUp(through, version as number, text));
  }
  return error(404, "not found");
}

// The user's messages are signed with their name, or their address's.
async function chat(request: Request, users: Users, account: Registered): Promise<Response> {
  const one = new URL(request.url).pathname.match(/^\/api\/chat\/(\d+)(\/delivered)?$/);
  if (one) {
    const id = Number(one[1]);
    if (one[2]) return request.method === "POST" ? reply(await users.deliver(id)) : error(405, "method not allowed");
    if (request.method === "PATCH") return reply(await users.edit(id, chatText((await body(request)).text)));
    if (request.method === "DELETE") {
      const gone = await users.unsay(id);
      return gone.ok ? new Response(null, { status: 204 }) : reply(gone);
    }
    return error(405, "method not allowed");
  }
  if (new URL(request.url).pathname !== "/api/chat") return error(404, "not found");
  if (request.method === "GET") {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new Invalid("after must be a message id");
    return json(await users.chat(after, 100));
  }
  if (request.method !== "POST") return error(405, "method not allowed");
  const text = chatText((await body(request)).text);
  const who = (await users.settings()).name ?? account.name ?? account.email.split("@")[0];
  return json(await users.post(who, text, true), 201);
}

// The user's settings, and what this Worker does for them: features the
// portal and the apps show only when they're there.
async function me(request: Request, env: Env, users: Users, account: Registered): Promise<Response> {
  const shown = async (s: Settings) => ({
    sub: account.sub,
    email: account.email,
    name: s.name ?? account.name,
    role: account.role,
    settings: s,
    features: {
      git: account.role === "admin" && !!env.FORGEJO_ORIGIN && !!env.FORGEJO_TOKEN,
      admin: account.role === "admin",
      calendar: !!(await users.calendarConnection()),
    },
  });
  if (request.method === "GET") return json(await shown(await users.settings()));
  if (request.method !== "PATCH") return error(405, "method not allowed");
  const { name, timezone, calendar, ...rest } = await body(request);
  if (Object.keys(rest).length) throw new Invalid(`unknown field ${Object.keys(rest)[0]}`);
  const f: Partial<Settings> = {};
  if (name !== undefined) {
    if (name !== null && (typeof name !== "string" || !name.trim() || name.length > 80)) throw new Invalid("name must be a line of at most 80 characters, or null");
    f.name = typeof name === "string" ? name.trim() : null;
  }
  if (timezone !== undefined) {
    const z = zone(timezone);
    if (!z) throw new Invalid("timezone must be an IANA zone, like America/Phoenix");
    f.timezone = z;
  }
  if (calendar !== undefined) {
    if (calendar !== null && (typeof calendar !== "string" || !/^[\w.@#-]{1,200}$/.test(calendar))) throw new Invalid("calendar must be a Google calendar id, or null");
    f.calendar = calendar as string | null;
  }
  return json(await shown(await users.setSettings(f)));
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

// An accepted day onto the Claude calendar, after the answer: how it went
// is the plan's calendar, heard live. Only today's and the week ahead's:
// a day gone by is the record of what was planned, and one further off
// (test/day-plan.ts plans in 2099) isn't a calendar's yet.
const CALENDAR_DAYS = 7;
async function toCalendar(env: Env, users: Users, ctx: ExecutionContext, result: Result<Plan>) {
  if (!result.ok || !result.value.accepted) return;
  const plan = result.value;
  const settings = await users.settings();
  const ahead = (Date.parse(plan.date) - Date.parse(today(settings.timezone))) / 86400_000;
  if (ahead < 0 || ahead > CALENDAR_DAYS) return;
  const accepted = plan.accepted!;
  ctx.waitUntil(
    (async () => {
      let result: { blocks: number } | { error: string };
      try {
        result = { blocks: await writeCalendar(env, await users.calendarConnection(), plan, settings) };
      } catch (e) {
        console.error(`calendar for ${plan.date}: ${calendarError(e)}`);
        result = { error: calendarError(e) };
      }
      await users.calendarWritten(plan.date, accepted, result);
    })().catch((e) => console.error(`calendar for ${plan.date}: ${e}`)),
  );
}

async function plans(request: Request, env: Env, users: Users, ctx: ExecutionContext): Promise<Response> {
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
    case "accept": {
      const accepted = await users.accept(day, version(), blocks(input.blocks));
      await toCalendar(env, users, ctx, accepted);
      return reply(accepted);
    }
    case "discard":
      return reply(await users.discard(day, version()));
    default: {
      const edited = await users.setDay(day, version(), blocks(input.blocks));
      await toCalendar(env, users, ctx, edited);
      return reply(edited);
    }
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
const TOKEN_ID = /^[0-9a-f]{64}$/;
// Machine tokens' longest life, when one is given: ten years.
const MACHINE_TTL_MAX = 10 * 365 * 24 * 3600;

// A token's id in the lists: its SHA-256, which is its key here too.
const tokenId = (token: string) => sha256(token);

// A token of this user's, by its KV key; another user's is as good as none.
async function own(env: Env, props: Props, key: string): Promise<Props | null> {
  const p = await env.OAUTH_KV.get<Props>(key, "json");
  return p && p.userId === props.userId ? p : null;
}

// machine: the environment, when a machine token asks. It mints and revokes
// the tokens its agents use, but no machine's.
async function tokens(request: Request, env: Env, props: Props, users: Users, machine?: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const one = path.match(/^\/api\/tokens\/machine\/([^/]+)$/);
  if (one) {
    if (machine) return error(403, "only the owner revokes a machine's token");
    if (request.method !== "DELETE") return error(405, "method not allowed");
    if (!TOKEN_ID.test(one[1])) return error(404, `no token ${one[1]}`);
    const key = `card-token:${one[1]}`;
    const listed = await users.forgetMachineToken(one[1]);
    const p = await own(env, props, key);
    if (!listed && !p) return error(404, `no token ${one[1]}`);
    if (p) await env.OAUTH_KV.delete(key);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/tokens/machine" && request.method === "GET") {
    if (machine) return error(403, "only the owner lists the machines' tokens");
    return json(await users.machineTokens());
  }
  if (request.method !== "POST") return error(405, "method not allowed");
  const input = await body(request);
  if (path === "/api/tokens/revoke") {
    if (typeof input.token !== "string") throw new Invalid("token must be the token to revoke");
    const key = await tokenKey(input.token);
    const p = await own(env, props, key);
    if (machine && p?.grant?.kind === "machine") return error(403, "only the owner revokes a machine's token");
    if (p) await env.OAUTH_KV.delete(key);
    if (p?.grant?.kind === "machine") await users.forgetMachineToken(await tokenId(input.token));
    return new Response(null, { status: 204 });
  }
  if (path === "/api/tokens/machine") {
    if (machine) return error(403, "only the owner mints a machine's token");
    const { environment, label = null, expires_in = null } = input;
    if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) throw new Invalid("environment must be the machine's environment name");
    if (label !== null && (typeof label !== "string" || label.length > 100)) throw new Invalid("label must be a line of at most 100 characters");
    if (expires_in !== null && !(Number.isInteger(expires_in) && (expires_in as number) >= 60 && (expires_in as number) <= MACHINE_TTL_MAX))
      throw new Invalid("expires_in must be seconds from now, at least 60, or null for until it's revoked");
    const minted = await mintToken(env, props, { kind: "machine", environment, agent: environment }, expires_in as number | null);
    const id = await tokenId(minted.token);
    await users.addMachineToken({ id, environment, label: (label as string | null)?.trim() || null, created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), expires: minted.expires_at, used: null });
    return json({ ...minted, id }, 201);
  }
  if (path === "/api/tokens/pepper" || path === "/api/tokens/brain") {
    const name = path === "/api/tokens/pepper" ? "pepper" : String(input.brain ?? "");
    const b = await live(env, props.userId, name);
    if (!b) throw new Invalid(`no brain ${name}`);
    return mint(env, props, { kind: "brain", brain: b.name, agent: b.name, id: b.id });
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

// When each machine token was last used, as its list shows it: noted at
// most this often, from each isolate.
const USE_EVERY = 5 * 60_000;
const used = new Map<string, number>();

async function noteUse(users: Users, token: string, environment: string) {
  const id = await tokenId(token);
  if ((used.get(id) ?? 0) > Date.now() - USE_EVERY) return;
  used.set(id, Date.now());
  await users.machineTokenUsed(id, environment);
}

// The OAuth clients signed in as the user (the bridge, the portal, the
// phone, Claude Code sessions), each a grant of the provider's; revoking
// one ends its tokens. current: the one asking.
async function grants(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const id = new URL(request.url).pathname.match(/^\/api\/grants(?:\/([^/]+))?$/);
  if (!id) return error(404, "not found");
  if (id[1]) {
    if (request.method !== "DELETE") return error(405, "method not allowed");
    await oauth.revokeGrant(decodeURIComponent(id[1]), ctx.props.userId);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET") return error(405, "method not allowed");
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(ctx.props.userId, { cursor });
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor && all.length < 500);
  const names = new Map<string, string | null>();
  for (const g of all) if (!names.has(g.clientId)) names.set(g.clientId, (await oauth.lookupClient(g.clientId).catch(() => null))?.clientName ?? null);
  const at = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  return json(
    all
      .map((g) => ({ id: g.id, client: names.get(g.clientId) ?? g.clientId, client_id: g.clientId, scope: g.scope, created: at(g.createdAt), current: g.clientId === ctx.auth.clientId }))
      .sort((a, b) => b.created.localeCompare(a.created)),
  );
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
// each brain's memory, table by table (dump.ts), and the holds with their
// secrets (holds.ts). The other Worker takes it only while it has no boards.
// Sign-ins don't move: every client signs in there again.
type Account = { version: 1; user: Dump; boards: Record<string, Dump>; memory: Record<string, Dump>; holds?: HoldsDump };

async function exportAccount(env: Env, userId: string, users: Users): Promise<Account> {
  const boards: Account["boards"] = {};
  for (const b of await users.boards()) boards[b.key] = await env.BOARD.get(env.BOARD.idFromName(`${userId}/${b.key}`)).dump();
  const memory: Account["memory"] = {};
  for (const b of await users.brains(true)) memory[b.name] = await env.MEMORY.get(env.MEMORY.idFromName(`${userId}/${b.name}`)).dump();
  return { version: 1, user: await users.dump(), boards, memory, holds: await dumpHolds(env, userId) };
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
    for (const [brain, d] of Object.entries(a.memory!)) {
      if (!BRAIN_NAME.test(brain)) throw new Invalid(`bad brain name ${brain}`);
      await step(`memory ${brain}`, await env.MEMORY.get(env.MEMORY.idFromName(`${userId}/${brain}`)).restore(d!));
    }
    if (a.holds) counts.holds = await restoreHolds(env, userId, a.holds);
  } catch (e: any) {
    if (e instanceof Invalid) throw e;
    return error(e.status ?? 500, e.message, { restored: counts });
  }
  return json({ restored: counts }, 201);
}

// Who's asking, for the MCP server: a card or brain token says; OAuth
// tokens by scope, in the default brain. A brain's is read with the brain:
// its abilities, and refused once it's archived or purged. Pepper's from
// before brains were data is the pepper brain's.
async function grantOf(env: Env, ctx: OAuthResourceContext<Props>): Promise<Grant | undefined> {
  let g = ctx.props.grant;
  if (g?.kind === "machine") return undefined;
  if (g?.kind === "pepper") g = { kind: "brain", brain: "pepper", agent: g.agent };
  if (g?.kind === "brain") {
    const b = await live(env, ctx.props.userId, g.brain, g.id);
    return b && { ...g, abilities: b.abilities };
  }
  if (g) return g;
  const kind = ctx.auth.scope.includes("owner") ? "owner" : ctx.auth.scope.includes("assistant") ? "assistant" : undefined;
  if (!kind) return undefined;
  const brain = (await env.USER.get(env.USER.idFromName(ctx.props.userId)).defaultBrain())?.name;
  return { kind, agent: kind === "owner" ? "claude" : "assistant", brain };
}

export const api = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Every token's account must be let in, whatever the token: one an
    // admin has disabled since is refused here (registry.ts).
    const account = await accountOf(env, ctx.props);
    if (account?.status !== "active") return error(403, account?.status === "disabled" ? "this account is disabled" : "this account isn't let in");
    if (path === "/mcp") {
      const grant = await grantOf(env, ctx);
      if (!grant) return insufficientScope(ctx.auth, ["assistant"]);
      return mcp(request, env, ctx.props.userId, grant);
    }
    if (path.startsWith("/memory/")) {
      const grant = await grantOf(env, ctx);
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
    const users = env.USER.get(env.USER.idFromName(ctx.props.userId));
    if (machine) await noteUse(users, ctx.auth.token, machine);
    const admin = account.role === "admin";
    try {
      if (path.startsWith("/api/tokens")) return await tokens(request, env, ctx.props, users, machine);
      if (path.startsWith("/api/spawns") || path.startsWith("/api/fleet/")) return await fleetRoutes(request, env, ctx.props, () => body(request), mintToken, machine);
      // A machine mints a brain's token (pepperd, Pepper's) and does nothing else with brains.
      if (path === "/api/brains" || path.startsWith("/api/brains/"))
        return machine && !/^\/api\/brains\/[^/]+\/tokens$/.test(path) ? error(403, "not with a machine token") : await brainRoutes(request, env, ctx.props, () => body(request), mintToken);
      if (path === "/api/holds" || path.startsWith("/api/holds/"))
        return machine ? error(403, "not with a machine token") : await holdRoutes(request, env, ctx.props.userId, () => body(request));
      if (path === "/api/me") return machine ? error(403, "not with a machine token") : await me(request, env, users, account);
      if (path === "/api/grants" || path.startsWith("/api/grants/")) return machine ? error(403, "not with a machine token") : await grants(request, env, ctx);
      const bridge = path.match(/^\/api\/bridges\/([\w-]{1,64})$/);
      if (bridge) {
        if (machine) return error(403, "not with a machine token");
        if (request.method !== "DELETE") return error(405, "method not allowed");
        return (await users.disconnectBridge(bridge[1])) ? new Response(null, { status: 204 }) : error(404, `bridge ${bridge[1]} isn't connected`);
      }
      if (path.startsWith("/api/admin/")) return machine || !admin ? error(403, "for admins") : await adminRoutes(request, env, account, () => body(request));
      // An encrypted account an admin makes, with no invite (e2ee.ts).
      if (path === "/api/e2ee/accounts") return machine || !admin ? error(403, "for admins") : request.method === "POST" ? await createAccount(request, env, account.email) : error(405, "method not allowed");
      if (path === "/api/live") return users.fetch(asMachine(request, machine));
      const brainParam = new URL(request.url).searchParams.get("brain");
      const brain = path.startsWith("/api/notes") || path === "/api/goals" || path.startsWith("/api/memory/") ? await brainNamed(env, ctx.props.userId, brainParam) : "";
      if (path.startsWith("/api/notes")) return await notes(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/goals") {
        if (request.method !== "GET") return error(405, "method not allowed");
        return json(goals(await (await memoryOf(env, ctx.props.userId, brain)).goalNotes()));
      }
      if (path === "/api/memory/entries" && request.method === "POST") return await importEntries(request, await memoryOf(env, ctx.props.userId, brain));
      if (path === "/api/memory/vectors") return json(await (await memoryOf(env, ctx.props.userId, brain)).vectorState());
      if (path.startsWith("/api/memory/")) return await browse(request, await memoryOf(env, ctx.props.userId, brain));
      if (path.startsWith("/api/plans/")) return await plans(request, env, users, ctx);
      if (path === "/api/chat" || path.startsWith("/api/chat/")) return await chat(request, users, account);
      if (path.startsWith("/api/sessions")) return await sessions(request, users, machine);
      if (path.startsWith("/api/workspace/")) return await workspace(request, env, ctx.props, users, machine);
      // Forgejo is read with one token, the first admin's (git.ts), so it's
      // the admins' alone.
      if (path === "/api/git" || path.startsWith("/api/git/")) return machine || !admin ? error(403, "not for this account") : await gitRoutes(request, env);
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
