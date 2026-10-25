// One board: its cards and their logs, in this Durable Object's SQLite. Every
// method runs to completion without awaiting, so each is a transaction and
// writes to one board happen one at a time; nothing else needs a lock.
//
// Methods return a Result instead of throwing, because an error crossing RPC
// keeps its message but not its class, and the Worker needs the status.

import { DurableObject } from "cloudflare:workers";
import { type BoardEvent, type Card, type Fields, type Imported, type LogEntry, type Status, waitingOn } from "./cards";

// card, plan: on a conflict, the thing as it is now, to redo the change on.
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; card?: Card; plan?: unknown };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string, card?: Card): Result<never> => ({ ok: false, status, error, card });
const NO_BOARD = fail(404, "no such board; PUT /api/boards/:board to make it");

type Row = Record<string, SqlStorageValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT,
  agent_state TEXT,
  attention TEXT,
  ordinal REAL,
  labels TEXT NOT NULL DEFAULT '[]',
  dependencies TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '{}',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id),
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_card ON log(card_id, seq);
CREATE TABLE IF NOT EXISTS meta (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  name TEXT NOT NULL,
  root TEXT
);
`;

// What a board is: a name, and the local project path corkboard maps it to.
export type BoardInfo = { key: string; name: string; root: string | null };

// Seconds, UTC, as the card logs have always been written.
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function card(row: Row): Card {
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as Status,
    agent: (row.agent as string | null) ?? null,
    agent_state: (row.agent_state as Card["agent_state"]) ?? null,
    attention: (row.attention as string | null) ?? null,
    ordinal: (row.ordinal as number | null) ?? null,
    labels: JSON.parse(row.labels as string),
    dependencies: JSON.parse(row.dependencies as string),
    description: row.description as string,
    extra: JSON.parse(row.extra as string),
    created: row.created as string,
    updated: row.updated as string,
    version: row.version as number,
  };
}

// A field's value as its column stores it.
const column = (k: string, v: unknown): SqlStorageValue =>
  ["labels", "dependencies", "extra"].includes(k) ? JSON.stringify(v) : (v as SqlStorageValue);

export class Board extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // A board exists once it has been named (PUT /api/boards/:key); until then
  // every card method answers 404, so a mistyped key can't start a board.
  private exists(): boolean {
    return this.sql.exec("SELECT 1 FROM meta").toArray().length > 0;
  }

  describe(name: string, root: string | null): void {
    this.sql.exec(
      "INSERT INTO meta (one, name, root) VALUES (1, ?, ?) ON CONFLICT (one) DO UPDATE SET name = excluded.name, root = excluded.root",
      name,
      root,
    );
  }

  // Everything the board holds, and its live sockets.
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "board deleted");
    await this.ctx.storage.deleteAll();
    this.sql.exec(SCHEMA);
  }

  private find(id: string): Card | undefined {
    const rows = this.sql.exec("SELECT * FROM cards WHERE id = ?", id).toArray();
    return rows.length ? card(rows[0]) : undefined;
  }

  private logOf(id: string): LogEntry[] {
    return this.sql.exec("SELECT seq, at, who, note FROM log WHERE card_id = ? ORDER BY seq", id).toArray() as LogEntry[];
  }

  // Every open live socket hears about every write, after it's committed.
  private broadcast(event: BoardEvent) {
    const text = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {} // closing; it's gone from the list next time
    }
  }

  // In board order: by ordinal, unordered cards last, then by number. With
  // log, each card carries its log too: a whole copy of the board at once,
  // which is what a live copy starts from.
  list(log = false): Result<(Card & { waiting_on: string[]; log?: LogEntry[] })[]> {
    if (!this.exists()) return NO_BOARD;
    const cards = this.sql
      .exec("SELECT * FROM cards ORDER BY ordinal IS NULL, ordinal, n")
      .toArray()
      .map(card);
    return ok(cards.map((c) => ({ ...c, waiting_on: waitingOn(c, cards), ...(log ? { log: this.logOf(c.id) } : {}) })));
  }

  get(id: string): Result<Card & { log: LogEntry[] }> {
    if (!this.exists()) return NO_BOARD;
    const c = this.find(id);
    if (!c) return fail(404, `no card ${id}`);
    return ok({ ...c, log: this.logOf(id) });
  }

  // GET /api/boards/:board/live, forwarded here: a WebSocket that receives a
  // BoardEvent per write. Hibernatable, so an idle board costs nothing while
  // its sockets stay open; it answers "ping" with "pong" without waking.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    if (!this.exists()) return new Response(NO_BOARD.ok ? "" : NO_BOARD.error, { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Sockets only listen; anything they send but pings is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }

  // Cards from elsewhere (corkboard import), with their own ids, times and
  // logs. Only into an empty board, so an import never overwrites anything.
  import(cards: Imported[]): Result<number> {
    if (!this.exists()) return NO_BOARD;
    if (this.sql.exec("SELECT count(*) AS n FROM cards").one().n) return fail(409, "the board already has cards; import only into an empty one");
    const ids = new Set(cards.map((c) => c.id));
    if (ids.size !== cards.length) return fail(400, "two cards have the same id");
    for (const c of cards) {
      const values: Record<string, unknown> = {
        status: "backlog",
        ...c.fields,
        id: c.id,
        n: Number(c.id.match(/(\d+)$/)![1]),
        created: c.created,
        updated: c.updated,
      };
      const keys = Object.keys(values);
      this.sql.exec(
        `INSERT INTO cards (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        ...keys.map((k) => column(k, values[k])),
      );
      for (const e of c.log) this.sql.exec("INSERT INTO log (card_id, at, who, note) VALUES (?, ?, ?, ?)", c.id, e.at, e.who, e.note);
    }
    const all = this.list(true);
    if (all.ok) this.broadcast({ type: "snapshot", cards: all.value });
    return ok(cards.length);
  }

  // Numbered one past the highest id the board has had, so ids are never
  // reused.
  create(f: Fields): Result<Card> {
    if (!this.exists()) return NO_BOARD;
    if (!f.title) return fail(400, "a card needs a title");
    const n = ((this.sql.exec("SELECT max(n) AS n FROM cards").one().n as number | null) ?? 0) + 1;
    const id = `TASK-${n}`;
    const t = now();
    const values: Record<string, unknown> = { status: "backlog", ...f, id, n, created: t, updated: t };
    const keys = Object.keys(values);
    this.sql.exec(
      `INSERT INTO cards (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      ...keys.map((k) => column(k, values[k])),
    );
    const made = this.find(id)!;
    this.broadcast({ type: "card", card: made });
    return ok(made);
  }

  // version: the one the caller read. A mismatch is a conflict, answered
  // with the card as it is now so the caller can redo its change on that.
  update(id: string, f: Fields, version: number): Result<Card> {
    if (!this.exists()) return NO_BOARD;
    const current = this.find(id);
    if (!current) return fail(404, `no card ${id}`);
    if (current.version !== version) return fail(409, `card ${id} is at version ${current.version}, not ${version}`, current);
    const keys = Object.keys(f);
    if (!keys.length) return fail(400, "nothing to change");
    this.sql.exec(
      `UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ?, version = version + 1 WHERE id = ?`,
      ...keys.map((k) => column(k, f[k as keyof Fields])),
      now(),
      id,
    );
    const changed = this.find(id)!;
    this.broadcast({ type: "card", card: changed });
    return ok(changed);
  }

  // Appends commute, so a log entry takes no version and doesn't bump it:
  // an agent logging progress never conflicts with an edit in the UI.
  appendLog(id: string, who: string, note: string): Result<LogEntry> {
    if (!this.exists()) return NO_BOARD;
    if (!this.find(id)) return fail(404, `no card ${id}`);
    const at = now();
    const { seq } = this.sql
      .exec("INSERT INTO log (card_id, at, who, note) VALUES (?, ?, ?, ?) RETURNING seq", id, at, who, note)
      .one() as { seq: number };
    this.sql.exec("UPDATE cards SET updated = ? WHERE id = ?", at, id);
    const entry = { seq, at, who, note };
    this.broadcast({ type: "log", id, entry });
    return ok(entry);
  }
}
