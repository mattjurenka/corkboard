// One user: the boards they have, their day plans and their chat with
// Pepper. (Their notes were here; they are Pepper's brain now, memory.ts.) Each board's cards live in its
// own Board object; this lists them, so GET /api/boards is one call.
//
// Plans change by version, like cards: a write names the version it read,
// and a stale one gets a 409 with the plan as it is. Every plan change and
// chat message goes to the user's live sockets (GET /api/live), which is how
// the day plan's window hears of a proposal the moment it's made, and the
// phone of Pepper's reply.

import { DurableObject } from "cloudflare:workers";
import type { BoardInfo, Result } from "./board";
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
