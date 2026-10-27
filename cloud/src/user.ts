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
`;

export class User extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // Boards ----------------------------------------------------------------------------

  boards(): BoardInfo[] {
    return this.sql.exec("SELECT key, name, root FROM boards ORDER BY name, key").toArray() as BoardInfo[];
  }

  forget(key: string): void {
    this.sql.exec("DELETE FROM boards WHERE key = ?", key);
  }

  remember(board: BoardInfo): void {
    this.sql.exec(
      "INSERT INTO boards (key, name, root) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, root = excluded.root",
      board.key,
      board.name,
      board.root,
    );
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

  putEnvironment(e: Environment): void {
    this.sql.exec("INSERT INTO environments (name, doc) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET doc = excluded.doc", e.name, JSON.stringify(e));
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

  // Live ------------------------------------------------------------------------------

  private broadcast(event: object) {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
}
