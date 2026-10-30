// One user: the boards they have, their day plans, their chat with
// Pepper, and their fleet's spawns (fleet.ts). (Their notes were here; they are Pepper's brain now, memory.ts.) Each board's cards live in its
// own Board object; this lists them, so GET /api/boards is one call.
//
// Plans change by version, like cards: a write names the version it read,
// and a stale one gets a 409 with the plan as it is. Every plan change and
// chat message goes to the user's live sockets (GET /api/live), which is how
// the day plan's window hears of a proposal the moment it's made, and the
// phone of Pepper's reply.

import { DurableObject } from "cloudflare:workers";
import type { BoardInfo, Result } from "./board";
import { type Dump, dump, restore } from "./dump";
import { type Environment, type Spawn, type SpawnReport, FINAL, type SpawnState } from "./fleet";
import {
  type Block,
  type ChatMessage,
  type Note,
  type Plan,
  type Proposal,
  emptyPlan,
} from "./plans";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string, plan?: Plan): Result<never> => ({ ok: false, status, error, plan });
const refuse = (status: number, error: string): Result<never> => ({ ok: false, status, error });

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS plans (date TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS environments (name TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spawns (id TEXT PRIMARY KEY, created TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bridges (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS board_roots (key TEXT NOT NULL, environment TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY (key, environment));
`;

export class User extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    const boards = this.sql.exec("SELECT name FROM pragma_table_info('boards')").toArray();
    if (!boards.some((c) => c.name === "first_commit")) this.sql.exec("ALTER TABLE boards ADD COLUMN first_commit TEXT");
    if (!boards.some((c) => c.name === "remotes")) this.sql.exec("ALTER TABLE boards ADD COLUMN remotes TEXT");
    // Briefly the portal's Forgejo sign-ins (2026-10-30), now a Worker secret (git.ts).
    this.sql.exec("DROP TABLE IF EXISTS links");
  }

  // Everything here, to copy it to another account's Worker (dump.ts). The
  // bridges say who they are again when they connect there.
  dump(): Dump {
    return dump(this.sql, ["bridges"]);
  }

  // Into a user with no boards yet.
  restore(d: Dump): Result<number> {
    if (this.boards().length) return refuse(409, "this account already has boards");
    return ok(restore(this.sql, d));
  }

  // Boards ----------------------------------------------------------------------------

  // commit: only the boards of the repository with that first commit. Each
  // with its remotes, and the environments that have a clone of it.
  boards(commit?: string): BoardInfo[] {
    const select = "SELECT key, name, root, first_commit AS 'commit', remotes FROM boards";
    const rows = commit ? this.sql.exec(`${select} WHERE first_commit = ? ORDER BY name, key`, commit) : this.sql.exec(`${select} ORDER BY name, key`);
    const placed = new Map<string, string[]>();
    for (const r of this.sql.exec("SELECT key, environment FROM board_roots ORDER BY environment")) placed.set(r.key as string, [...(placed.get(r.key as string) ?? []), r.environment as string]);
    return rows.toArray().map((r) => ({
      key: r.key as string,
      name: r.name as string,
      root: r.root as string | null,
      commit: r.commit as string | null,
      remotes: r.remotes ? (JSON.parse(r.remotes as string) as string[]) : [],
      environments: placed.get(r.key as string) ?? [],
    }));
  }

  board(key: string): BoardInfo | undefined {
    return this.boards().find((b) => b.key === key);
  }

  forget(key: string): void {
    this.sql.exec("DELETE FROM boards WHERE key = ?", key);
    this.sql.exec("DELETE FROM board_roots WHERE key = ?", key);
  }

  // A commit, once known, stays: a board isn't moved to another repository.
  // Remotes left out stay as they were.
  remember(board: BoardInfo): void {
    this.sql.exec(
      `INSERT INTO boards (key, name, root, first_commit, remotes) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET
         name = excluded.name, root = excluded.root, first_commit = COALESCE(boards.first_commit, excluded.first_commit),
         remotes = COALESCE(excluded.remotes, boards.remotes)`,
      board.key,
      board.name,
      board.root,
      board.commit ?? null,
      board.remotes ? JSON.stringify(board.remotes) : null,
    );
  }

  // Where an environment's clone of the board's project is.
  place(key: string, environment: string, root: string): void {
    this.sql.exec(
      "INSERT INTO board_roots (key, environment, root) VALUES (?, ?, ?) ON CONFLICT (key, environment) DO UPDATE SET root = excluded.root",
      key,
      environment,
      root,
    );
  }

  // The project's path in an environment: its own clone's, or else the one
  // the board was last opened at, which may be a path there too.
  rootIn(key: string, environment: string): string | null {
    const placed = this.sql.exec("SELECT root FROM board_roots WHERE key = ? AND environment = ?", key, environment).toArray()[0];
    return (placed?.root as string | undefined) ?? this.board(key)?.root ?? null;
  }

  // Notes -----------------------------------------------------------------------------

  // The notes as they were before they moved to Pepper's brain (memory.ts),
  // for its first open(). Kept here, and no longer written.
  exportNotes(): Note[] {
    return this.sql.exec("SELECT * FROM notes ORDER BY id").toArray() as Note[];
  }

  // Plans -----------------------------------------------------------------------------

  plan(date: string): Plan {
    const row = this.sql.exec("SELECT doc FROM plans WHERE date = ?", date).toArray()[0];
    return row ? (JSON.parse(row.doc as string) as Plan) : emptyPlan(date);
  }

  // A change to a date's plan, at the version the caller read (null: whatever
  // it is now, for the assistant's proposals, which replace the last one).
  private changePlan(date: string, version: number | null, fn: (p: Plan) => string | void): Result<Plan> {
    const p = this.plan(date);
    if (version !== null && p.version !== version) return fail(409, `the plan for ${date} is at version ${p.version}, not ${version}`, p);
    const refused = fn(p);
    if (refused) return fail(400, refused, p);
    p.version += 1;
    this.sql.exec("INSERT INTO plans (date, doc) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET doc = excluded.doc", date, JSON.stringify(p));
    this.broadcast({ type: "plan", plan: p });
    return ok(p);
  }

  propose(date: string, proposal: Omit<Proposal, "answering">, projects?: Plan["projects"]): Result<Plan> {
    return this.changePlan(date, null, (p) => {
      p.proposal = { ...proposal, answering: p.asked };
      p.asked = [];
      if (projects) p.projects = projects;
    });
  }

  say(date: string, text: string): Result<Plan> {
    return this.changePlan(date, null, (p) => {
      p.asked.push(text);
    });
  }

  // The proposal, as the user left it after undoing what they didn't want,
  // becomes the day. The calendar was written by then (plan.lua runs
  // dayplan apply first).
  accept(date: string, version: number, blocks: Block[]): Result<Plan> {
    return this.changePlan(date, version, (p) => {
      if (!p.proposal) return "there's no proposal to accept";
      p.day = {
        blocks,
        ranked: p.proposal.ranked ?? p.day.ranked,
        later: p.proposal.later ?? p.day.later,
        inputs: p.proposal.inputs ?? p.day.inputs,
      };
      p.proposal = null;
      p.accepted = now();
    });
  }

  discard(date: string, version: number): Result<Plan> {
    return this.changePlan(date, version, (p) => {
      if (!p.proposal) return "there's no proposal to discard";
      p.proposal = null;
    });
  }

  // The day itself edited (a block retitled or pinned in the plan window).
  setDay(date: string, version: number, blocks: Block[]): Result<Plan> {
    return this.changePlan(date, version, (p) => {
      p.day.blocks = blocks;
    });
  }

  deletePlan(date: string): void {
    this.sql.exec("DELETE FROM plans WHERE date = ?", date);
  }

  // Chat ------------------------------------------------------------------------------

  // The messages after an id, oldest first; with none, the newest `limit`.
  chat(after: number, limit: number): ChatMessage[] {
    if (after > 0) return this.sql.exec("SELECT * FROM chat WHERE id > ? ORDER BY id LIMIT ?", after, limit).toArray() as ChatMessage[];
    return (this.sql.exec("SELECT * FROM chat ORDER BY id DESC LIMIT ?", limit).toArray() as ChatMessage[]).reverse();
  }

  post(who: string, text: string): ChatMessage {
    const message = this.sql.exec("INSERT INTO chat (at, who, text) VALUES (?, ?, ?) RETURNING *", now(), who, text).one() as ChatMessage;
    this.broadcast({ type: "chat", message });
    return message;
  }

  // Fleet -----------------------------------------------------------------------------
  //
  // Where agents run, as each environment's fleetd last said, and every
  // spawn. The states only move forward: pending-approval → queued →
  // running → done, failed or stopped. Each change goes to the live sockets,
  // which is how fleetd hears of a spawn the moment it's made.

  // A change in what runs there goes to the live sockets too (the fleet
  // view); one that only says fleetd is still there doesn't.
  putEnvironment(e: Environment): Environment {
    const row = this.sql.exec("SELECT doc FROM environments WHERE name = ?", e.name).toArray()[0];
    const before = row ? (JSON.parse(row.doc as string) as Environment) : undefined;
    // A fleetd that says nothing of what's running keeps what it last said.
    if (!e.running && before?.running) e = { ...e, running: before.running };
    this.sql.exec("INSERT INTO environments (name, doc) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET doc = excluded.doc", e.name, JSON.stringify(e));
    // Nor does one only in its machine's load, free memory or uptime.
    const steady = (x?: Environment) =>
      x && JSON.stringify({ ...x, seen: "", running: x.running && { ...x.running, host: x.running.host && { ...x.running.host, available: 0, load: [], uptime: 0 } } });
    if (steady(before) !== steady(e)) this.broadcast({ type: "fleet", environment: e });
    return e;
  }

  // One no fleetd runs as any more. Each view sees it gone on its next load.
  forgetEnvironment(name: string): boolean {
    return this.sql.exec("DELETE FROM environments WHERE name = ? RETURNING name", name).toArray().length > 0;
  }

  environments(): Environment[] {
    return this.sql.exec("SELECT doc FROM environments ORDER BY name").toArray().map((r) => JSON.parse(r.doc as string));
  }

  spawn(id: string): Spawn | undefined {
    const row = this.sql.exec("SELECT doc FROM spawns WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.doc as string) : undefined;
  }

  // The newest first; environment and states narrow it.
  spawns(environment?: string, states?: SpawnState[], limit = 50): Spawn[] {
    return this.sql
      .exec("SELECT doc FROM spawns ORDER BY created DESC, id DESC")
      .toArray()
      .map((r) => JSON.parse(r.doc as string) as Spawn)
      .filter((s) => (!environment || s.environment === environment) && (!states?.length || states.includes(s.state)))
      .slice(0, limit);
  }

  private saveSpawn(s: Spawn): Spawn {
    this.sql.exec("INSERT INTO spawns (id, created, doc) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc", s.id, s.created, JSON.stringify(s));
    this.broadcast({ type: "spawn", spawn: s });
    return s;
  }

  addSpawn(s: Spawn): Spawn {
    return this.saveSpawn(s);
  }

  approveSpawn(id: string): Result<Spawn> {
    const s = this.spawn(id);
    if (!s) return refuse(404, `no spawn ${id}`);
    if (s.state !== "pending-approval") return refuse(409, `spawn ${id} is ${s.state}, not waiting for approval`);
    return ok(this.saveSpawn({ ...s, state: "queued", approved: now() }));
  }

  // fleetd taking a queued spawn to run. Claiming one it already claimed is
  // fine (it lost the answer); another environment's isn't.
  claimSpawn(id: string, environment: string): Result<Spawn> {
    const s = this.spawn(id);
    if (!s) return refuse(404, `no spawn ${id}`);
    if (s.environment !== environment) return refuse(409, `spawn ${id} runs in ${s.environment}, not ${environment}`);
    if (s.state !== "queued") return refuse(409, `spawn ${id} is ${s.state}, not queued`);
    return ok(s.claimed ? s : this.saveSpawn({ ...s, claimed: now() }));
  }

  // What fleetd says happened. A spawn that's over stays as it ended.
  reportSpawn(id: string, r: SpawnReport): Result<Spawn> {
    const s = this.spawn(id);
    if (!s) return refuse(404, `no spawn ${id}`);
    if (s.state === r.state) return ok(s);
    if (FINAL.includes(s.state)) return refuse(409, `spawn ${id} is already ${s.state}`);
    if (r.state === "running" && s.state !== "queued") return refuse(409, `spawn ${id} is ${s.state}, not queued`);
    if (r.state === "queued" || r.state === "pending-approval") return refuse(400, "a spawn goes back to no earlier state");
    const at = now();
    return ok(
      this.saveSpawn({
        ...s,
        ...r,
        ...(r.state === "running" ? { started: at } : { ended: at }),
      }),
    );
  }

  // Before it runs, a stop ends it; once it runs, fleetd stops its slot and
  // reports it stopped.
  stopSpawn(id: string): Result<Spawn> {
    const s = this.spawn(id);
    if (!s) return refuse(404, `no spawn ${id}`);
    if (FINAL.includes(s.state)) return refuse(409, `spawn ${id} is already ${s.state}`);
    if (s.state === "running") return ok(this.saveSpawn({ ...s, stopRequested: true }));
    return ok(this.saveSpawn({ ...s, state: "stopped", ended: now() }));
  }

  // Bridges ---------------------------------------------------------------------------
  //
  // A bridge that follows the live socket as one (?bridge=<id>) says what
  // Claude Code sessions its pages have whenever that changes, and they're
  // its while its socket is open. What the phone asks of a session (its
  // screen, something typed into it) goes to the bridge over that socket,
  // and the bridge's answer comes back the same way.

  private asked = new Map<string, (answer: Record<string, unknown>) => void>();
  private nextAsk = 1;

  private connected(bridge: string) {
    return this.ctx.getWebSockets(`bridge:${bridge}`);
  }

  bridges(): Bridge[] {
    return this.sql
      .exec("SELECT id, doc FROM bridges ORDER BY id")
      .toArray()
      .flatMap((r) => (this.connected(r.id as string).length ? [JSON.parse(r.doc as string) as Bridge] : []));
  }

  private setBridge(b: Bridge) {
    this.sql.exec("INSERT INTO bridges (id, doc) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc", b.id, JSON.stringify(b));
    this.broadcast({ type: "bridge", bridge: b });
  }

  private dropBridge(id: string) {
    if (!this.sql.exec("DELETE FROM bridges WHERE id = ? RETURNING id", id).toArray().length) return;
    this.broadcast({ type: "bridge", bridge: { id, gone: true } });
  }

  // A question for a bridge, answered by it or, after a while, refused.
  async ask(bridge: string, question: Question): Promise<Result<Answer>> {
    const ws = this.connected(bridge)[0];
    if (!ws) return refuse(404, `bridge ${bridge} isn't connected`);
    const id = this.nextAsk++;
    const key = `${bridge}:${id}`;
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      this.asked.set(key, resolve);
      setTimeout(() => resolve({ error: "the bridge didn't answer" }), 10_000);
    }).finally(() => this.asked.delete(key));
    try {
      ws.send(JSON.stringify({ ...question, ask: id }));
    } catch {
      this.asked.get(key)?.({ error: "the bridge went away" });
    }
    const a = await answer;
    if (typeof a.error === "string") return refuse(a.missing ? 404 : 502, a.error.slice(0, 500));
    if (question.type !== "screen") return ok({ ok: true });
    const lines = Array.isArray(a.lines) ? a.lines.slice(-300).map((l) => String(l).slice(0, 1000)) : [];
    return ok({ lines, width: Number.isFinite(a.width) ? (a.width as number) : null, ...screenColors(a, lines.length) });
  }

  // Live ------------------------------------------------------------------------------

  private broadcast(event: object) {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      // A stream hears only its session.
      if (this.ctx.getTags(ws).some((t) => t.startsWith("stream:"))) continue;
      try {
        ws.send(text);
      } catch {}
    }
  }

  // ?bridge=<id>&machine=<name>[&url=]: a bridge's own socket. At
  // /api/sessions/:bridge/:key/attach, the phone following one of its
  // sessions: a stream the bridge sends the conversation down
  // (bridge/remote.ts), which hears nothing else.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const url = new URL(request.url);
    const attach = url.pathname.match(/^\/api\/sessions\/([\w-]{1,64})\/([\w.-]{1,64})\/attach$/);
    const bridge = attach ? attach[1] : url.searchParams.get("bridge");
    if (bridge !== null && !BRIDGE.test(bridge)) return new Response("bad bridge id", { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    if (attach) {
      const to = this.connected(attach[1])[0];
      if (!to) return Response.json({ error: `bridge ${attach[1]} isn't connected` }, { status: 404 });
      const stream = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, [`stream:${stream}`, `streams:${attach[1]}`]);
      server.serializeAttachment({ bridge: attach[1], stream } satisfies Attached);
      to.send(JSON.stringify({ type: "attach", stream, key: attach[2] }));
    } else if (bridge) {
      // A machine's bridge is in its environment, whatever it says, and
      // can't take over one that's elsewhere's.
      const pinned = request.headers.get(MACHINE_HEADER) ?? undefined;
      if (pinned) {
        const had = this.bridges().find((b) => b.id === bridge);
        const elsewhere = this.connected(bridge).some((ws) => (ws.deserializeAttachment() as { pinned?: string } | null)?.pinned !== pinned);
        if (elsewhere || (had?.environment && had.environment !== pinned)) return Response.json({ error: `bridge ${bridge} isn't ${pinned}'s` }, { status: 403 });
      }
      // One socket a bridge: a new one takes over.
      for (const ws of this.connected(bridge)) ws.close(4000, "the bridge connected again");
      this.ctx.acceptWebSocket(server, [`bridge:${bridge}`]);
      const page = url.searchParams.get("url");
      server.serializeAttachment({
        bridge,
        machine: (url.searchParams.get("machine") ?? "").slice(0, 64),
        url: page && /^https:\/\/[\w.-]+(:\d+)?$/.test(page) ? page : null,
        ...(pinned && { pinned }),
      } satisfies Attached);
    } else this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: client });
  }

  private stream(id: unknown, bridge: string) {
    if (typeof id !== "string") return undefined;
    return this.ctx.getWebSockets(`stream:${id}`).find((ws) => (ws.deserializeAttachment() as Attached).bridge === bridge);
  }

  // A bridge's sessions, its answer to a question, or what goes down a
  // stream. The phone says nothing on a stream; what it types goes by /say.
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const from = ws.deserializeAttachment() as Attached | null;
    if (!from || typeof raw !== "string") return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if ("stream" in from) return;
    if (m.type === "sessions" && Array.isArray(m.sessions)) {
      const environment = "pinned" in from && from.pinned ? from.pinned : typeof m.environment === "string" ? m.environment.slice(0, 64) : null;
      this.setBridge({ id: from.bridge, machine: from.machine, url: from.url ?? null, environment, sessions: m.sessions.slice(0, 64).map(bridgeSession).filter((s) => s.key) });
    } else if (m.type === "answer" && typeof m.ask === "number") this.asked.get(`${from.bridge}:${m.ask}`)?.(m);
    else if (m.type === "out" && typeof m.data === "string") this.stream(m.stream, from.bridge)?.send(JSON.stringify({ type: "out", data: m.data }));
    else if (m.type === "end") {
      const to = this.stream(m.stream, from.bridge);
      to?.send(JSON.stringify({ type: "end", why: typeof m.why === "string" ? m.why.slice(0, 200) : null }));
      to?.close(1000, "ended");
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    const from = ws.deserializeAttachment() as Attached | null;
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
    if (!from) return;
    if ("stream" in from) {
      try {
        this.connected(from.bridge)[0]?.send(JSON.stringify({ type: "detach", stream: from.stream }));
      } catch {}
      return;
    }
    // Unless another socket of the bridge's took over.
    if (!this.connected(from.bridge).every((w) => w === ws)) return;
    this.dropBridge(from.bridge);
    for (const s of this.ctx.getWebSockets(`streams:${from.bridge}`)) s.close(1011, "the bridge went away");
  }
}

// What a socket is, besides the phone's or the day plan's own: a bridge's,
// or a stream to one of its sessions. pinned: the environment of the machine
// token it came with (api.ts's /api/tokens/machine).
type Attached = { bridge: string; machine: string; url?: string | null; pinned?: string } | { bridge: string; stream: string };

// How api.ts tells this object that a socket is a machine token's, and whose.
export const MACHINE_HEADER = "Corkboard-Machine";

const BRIDGE = /^[\w-]{1,64}$/;
const KEY = /^[\w.-]{1,64}$/;

// A Claude Code session a bridge has: in one of its pages (bridge/away.ts's
// list), or, for fleetd, in one of its VMs. key: what it's asked for by, the
// bridge's own; spawn: a VM's, its spawn.
export type BridgeSession = {
  key: string;
  spawn: string | null;
  project: string;
  name: string;
  state: string;
  since: number | null;
  detail: string | null;
  // When you last said something to it, in epoch ms.
  typed: number | null;
  host: string | null;
  vm: string | null;
  role: string | null;
  card: string | null;
  context: number | null;
  // Whether the phone can open a terminal on it (attach).
  attach: boolean;
};
// What the phone asks of one, and what its bridge says.
export type Question = { type: "screen"; key: string } | { type: "say"; key: string; text: string; keys: string[] };
export type Answer = { lines?: string[]; width?: number | null; colors?: number[][][]; palette?: string[]; ok?: boolean };

// A screen's colors (corkboard/vt.lua), a list of runs per line, each
// [characters, fg, bg, flags], and the palette its 16 colors are, kept to
// numbers and to the lines that went.
function screenColors(a: Record<string, unknown>, count: number): Pick<Answer, "colors" | "palette"> {
  const out: Pick<Answer, "colors" | "palette"> = {};
  if (Array.isArray(a.colors)) {
    const run = (r: unknown) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? (r as number[]) : null);
    out.colors = a.colors.slice(-count).map((l) => (Array.isArray(l) ? l.slice(0, 500).map(run).filter((r) => r !== null) : []));
  }
  if (Array.isArray(a.palette) && a.palette.length === 16 && a.palette.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))) out.palette = a.palette as string[];
  return out;
}
// url: the page it serves, when it's reachable from anywhere (CORKBOARD_ORIGIN).
export type Bridge = { id: string; machine: string; url: string | null; environment: string | null; sessions: BridgeSession[] };

function bridgeSession(v: unknown): BridgeSession {
  const s = (v ?? {}) as Record<string, unknown>;
  const str = (x: unknown, n = 128) => (typeof x === "string" ? x.slice(0, n) : null);
  const num = (x: unknown) => (Number.isFinite(x) ? (x as number) : null);
  return {
    key: typeof s.key === "string" && KEY.test(s.key) ? s.key : "",
    spawn: str(s.spawn, 20),
    project: str(s.project) ?? "",
    name: str(s.name) ?? "Claude Code",
    state: str(s.state, 32) ?? "",
    since: num(s.since),
    detail: str(s.detail, 2000),
    typed: num(s.typed),
    host: str(s.host, 64),
    vm: str(s.vm, 64),
    role: str(s.role, 32),
    card: str(s.card, 32),
    context: num(s.context),
    attach: s.attach === true,
  };
}
