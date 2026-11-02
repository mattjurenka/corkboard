// One encrypted object's log (LOG, named <account>/<object>): ops appended
// in the order they arrive, each { id, device, seq, epoch, nonce,
// ciphertext, ts } and the position the relay gave it. The object never
// decrypts anything and couldn't: it has no keys. It checks sizes, keeps
// order, makes a repeated push harmless (an op id it has is answered with
// its position), and sends each new op to every socket following the log,
// after the ones a socket asked to catch up on. See lib/e2ee/sync.ts for
// the other side.
//
// The owner can compact it: a snapshot (the merged state up to a position,
// sealed) replaces the ops it covers, whose ids are kept so a repeated push
// of one is still answered with its old position. A snapshot is also how
// the object moves to a new key: the log's epoch is the latest snapshot's,
// and a push sealed under another is refused (409, with the epoch).

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./result";
import { LIMITS, OPAQUE, type LogRead, type NewOp, type Snapshot, type WireOp, b64url, fromB64url } from "../../lib/e2ee/wire";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  pos INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  seq INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  ts TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS compacted (id TEXT PRIMARY KEY, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot (one INTEGER PRIMARY KEY CHECK (one = 1), up_to INTEGER NOT NULL, epoch INTEGER NOT NULL, nonce BLOB NOT NULL, parts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot_parts (part INTEGER PRIMARY KEY, data BLOB NOT NULL);
`;

// SQLite holds at most 2 MB a value; a snapshot is kept in parts of this.
const PART = 1024 * 1024;

const now = () => new Date().toISOString();

type Row = { pos: number; id: string; device: string; seq: number; epoch: number; nonce: ArrayBuffer; ciphertext: ArrayBuffer; ts: string };
const wire = (r: Row): WireOp => ({
  id: r.id,
  device: r.device,
  seq: r.seq,
  pos: r.pos,
  ...(r.epoch && { epoch: r.epoch }),
  nonce: b64url(new Uint8Array(r.nonce)),
  ciphertext: b64url(new Uint8Array(r.ciphertext)),
  ts: r.ts,
});

const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });

// A push under another epoch than the log's: which one it's on.
export type Appended = Result<{ id: string; pos: number }[]> | { ok: false; status: 409; error: string; epoch: number };

export class Log extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  private schema() {
    this.sql.exec(SCHEMA);
    // A log from before epochs has ops without the column.
    const cols = this.sql.exec("PRAGMA table_info(ops)").toArray();
    if (!cols.some((c) => c.name === "epoch")) this.sql.exec("ALTER TABLE ops ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  }

  private meta(k: string): number {
    return (this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as number) ?? 0;
  }

  private setMeta(k: string, v: number) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  private get bytes(): number {
    return this.meta("bytes");
  }

  // The epoch pushes must be under: the latest snapshot's.
  get epoch(): number {
    return this.meta("epoch");
  }

  private snap(): { upTo: number; epoch: number; nonce: ArrayBuffer; parts: number } | undefined {
    const r = this.sql.exec("SELECT up_to, epoch, nonce, parts FROM snapshot WHERE one = 1").toArray()[0];
    return r ? { upTo: r.up_to as number, epoch: r.epoch as number, nonce: r.nonce as ArrayBuffer, parts: r.parts as number } : undefined;
  }

  private snapshotNow(): Snapshot | undefined {
    const s = this.snap();
    if (!s) return;
    const parts = this.sql
      .exec("SELECT data FROM snapshot_parts ORDER BY part")
      .toArray()
      .map((r) => new Uint8Array(r.data as ArrayBuffer));
    const ciphertext = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) ciphertext.set(p, (at += p.length) - p.length);
    return { upTo: s.upTo, epoch: s.epoch, nonce: b64url(new Uint8Array(s.nonce)), ciphertext: b64url(ciphertext) };
  }

  head(): number {
    const p = this.sql.exec("SELECT MAX(pos) AS p FROM ops").toArray()[0]?.p as number | null;
    return p ?? this.snap()?.upTo ?? 0;
  }

  // The position an op id was given, kept or compacted.
  private posOf(id: string): number | undefined {
    const had = this.sql.exec("SELECT pos FROM ops WHERE id = ? UNION ALL SELECT pos FROM compacted WHERE id = ?", id, id).toArray()[0];
    return had?.pos as number | undefined;
  }

  // ops as a client sends them; device: the token's, not the client's say.
  append(device: string, ops: NewOp[]): Appended {
    if (!Array.isArray(ops) || !ops.length) return fail(400, "ops must be a non-empty list");
    if (ops.length > LIMITS.batch) return fail(413, `at most ${LIMITS.batch} ops a push`);
    const parsed: { id: string; seq: number; epoch: number; nonce: Uint8Array; ciphertext: Uint8Array }[] = [];
    let bytes = 0;
    for (const o of ops) {
      if (!o || typeof o.id !== "string" || !OPAQUE.test(o.id)) return fail(400, "an op's id must be 16 to 64 base64url characters");
      if (!Number.isSafeInteger(o.seq) || o.seq < 0) return fail(400, "an op's seq must be a whole number");
      const epoch = o.epoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0) return fail(400, "an op's epoch must be a whole number");
      let nonce: Uint8Array, ciphertext: Uint8Array;
      try {
        nonce = fromB64url(o.nonce);
        ciphertext = fromB64url(o.ciphertext);
      } catch {
        return fail(400, "nonce and ciphertext must be base64url");
      }
      if (nonce.length !== 24) return fail(400, "a nonce is 24 bytes");
      if (ciphertext.length < 16) return fail(400, "a ciphertext has at least its 16-byte tag");
      if (ciphertext.length > LIMITS.op) return fail(413, `an op is at most ${LIMITS.op} bytes`);
      bytes += ciphertext.length;
      parsed.push({ id: o.id, seq: o.seq, epoch, nonce, ciphertext });
    }
    if (bytes > LIMITS.batchBytes) return fail(413, `a push is at most ${LIMITS.batchBytes} bytes`);
    if (this.bytes + bytes > LIMITS.log) return fail(413, "this log is full");
    // An op the log has is answered whatever its epoch; a new one must be
    // under the log's, or the whole push is refused.
    const epoch = this.epoch;
    if (parsed.some((o) => o.epoch !== epoch && this.posOf(o.id) === undefined)) return { ok: false, status: 409, error: `this log is on epoch ${epoch}: seal the ops under its key`, epoch };

    const acks: { id: string; pos: number }[] = [];
    const fresh: WireOp[] = [];
    this.ctx.storage.transactionSync(() => {
      let added = 0;
      for (const o of parsed) {
        const had = this.posOf(o.id);
        if (had !== undefined) {
          acks.push({ id: o.id, pos: had });
          continue;
        }
        const ts = now();
        const row = this.sql
          .exec("INSERT INTO ops (id, device, seq, epoch, nonce, ciphertext, ts) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING pos", o.id, device, o.seq, o.epoch, o.nonce, o.ciphertext, ts)
          .one();
        const pos = row.pos as number;
        acks.push({ id: o.id, pos });
        fresh.push({ id: o.id, device, seq: o.seq, pos, ...(o.epoch && { epoch: o.epoch }), nonce: b64url(o.nonce), ciphertext: b64url(o.ciphertext), ts });
        added += o.ciphertext.length;
      }
      this.setMeta("bytes", this.bytes + added);
    });
    if (fresh.length) this.fanOut({ ops: fresh });
    return { ok: true, value: acks };
  }

  // The owner's (e2ee.ts checks): the state up to upTo, which the ops at or
  // before it are dropped for. One that raises the epoch must be at the head,
  // so no op under the old key is left after it.
  snapshot(s: Snapshot): Result<{ upTo: number; epoch: number }> {
    if (!s || typeof s !== "object") return fail(400, "a snapshot is { upTo, epoch, nonce, ciphertext }");
    const { upTo, epoch } = s;
    if (!Number.isSafeInteger(upTo) || upTo < 1) return fail(400, "upTo must be a position in the log");
    if (!Number.isSafeInteger(epoch) || epoch < 0) return fail(400, "epoch must be a whole number");
    let nonce: Uint8Array, ciphertext: Uint8Array;
    try {
      nonce = fromB64url(s.nonce);
      ciphertext = fromB64url(s.ciphertext);
    } catch {
      return fail(400, "nonce and ciphertext must be base64url");
    }
    if (nonce.length !== 24) return fail(400, "a nonce is 24 bytes");
    if (ciphertext.length < 16) return fail(400, "a ciphertext has at least its 16-byte tag");
    if (ciphertext.length > LIMITS.snapshot) return fail(413, `a snapshot is at most ${LIMITS.snapshot} bytes`);
    const head = this.head();
    if (upTo > head) return fail(400, `upTo is past the log's head (${head})`);
    const last = this.snap()?.upTo ?? 0;
    // Past the last one; or at it, moving to a new key with nothing written
    // since (a member left right after another joined, say).
    if (upTo < last || (upTo === last && epoch <= this.epoch)) return fail(409, `the log has a snapshot up to ${last} already: read and try again`);
    if (epoch < this.epoch) return fail(409, `the log is on epoch ${this.epoch}: read and try again`);
    if (epoch > this.epoch && upTo !== head) return fail(409, `a new epoch's snapshot must be at the head (${head}): read and try again`);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM snapshot_parts");
      let parts = 0;
      for (let at = 0; at < ciphertext.length; at += PART) this.sql.exec("INSERT INTO snapshot_parts (part, data) VALUES (?, ?)", parts++, ciphertext.slice(at, at + PART));
      this.sql.exec(
        "INSERT INTO snapshot (one, up_to, epoch, nonce, parts) VALUES (1, ?, ?, ?, ?) ON CONFLICT (one) DO UPDATE SET up_to = excluded.up_to, epoch = excluded.epoch, nonce = excluded.nonce, parts = excluded.parts",
        upTo,
        epoch,
        nonce,
        parts,
      );
      this.sql.exec("INSERT INTO compacted (id, pos) SELECT id, pos FROM ops WHERE pos <= ? ON CONFLICT DO NOTHING", upTo);
      this.sql.exec("DELETE FROM ops WHERE pos <= ?", upTo);
      this.setMeta("epoch", epoch);
      this.setMeta("bytes", (this.sql.exec("SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) AS n FROM ops").one().n as number) ?? 0);
    });
    this.fanOut({ snapshot: { upTo, epoch, nonce: s.nonce, ciphertext: s.ciphertext } });
    return { ok: true, value: { upTo, epoch } };
  }

  // From since: the snapshot first when since is behind it, then the ops
  // after it. count and bytes are what's kept since the snapshot.
  read(since: number, limit: number = LIMITS.read): LogRead {
    const n = Math.max(1, Math.min(LIMITS.read, Math.floor(limit) || LIMITS.read));
    let from = Math.max(0, Math.floor(since) || 0);
    const s = this.snap();
    const snapshot = s && from < s.upTo ? this.snapshotNow() : undefined;
    if (snapshot) from = snapshot.upTo;
    const ops = this.sql
      .exec("SELECT * FROM ops WHERE pos > ? ORDER BY pos LIMIT ?", from, n)
      .toArray()
      .map((r) => wire(r as unknown as Row));
    const count = this.sql.exec("SELECT COUNT(*) AS n FROM ops").one().n as number;
    return { ops, head: this.head(), epoch: this.epoch, count, bytes: this.bytes, ...(snapshot && { snapshot }) };
  }

  // The owner's: the whole log, and everyone following it.
  deleteAll(): Result<{ ok: true }> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "the log was deleted");
      } catch {}
    }
    this.ctx.storage.transactionSync(() => {
      // Positions go on from where they were, so nothing following the log
      // mistakes a new op for one it had.
      for (const t of ["ops", "meta", "compacted", "snapshot", "snapshot_parts"]) this.sql.exec(`DELETE FROM ${t}`);
    });
    return { ok: true, value: { ok: true } };
  }

  // A member no longer shared with stops following it.
  drop(account: string) {
    for (const ws of this.ctx.getWebSockets(account)) {
      try {
        ws.close(1000, "no longer shared");
      } catch {}
    }
  }

  private fanOut(m: { ops: WireOp[] } | { snapshot: Snapshot }) {
    const msg = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  // A socket following the log (e2ee.ts checked who's asking, and says who
  // as X-Account): the snapshot if it's behind it, what it missed since
  // ?since=, then each op as it comes. Hibernates between.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0) || 0;
    const account = request.headers.get("X-Account");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, account ? [account] : []);
    // No await between reading and accepting, so no op lands in neither.
    for (let at = since, first = true; ; first = false) {
      const { ops, snapshot } = this.read(at);
      if (first && snapshot) {
        server.send(JSON.stringify({ snapshot }));
        at = snapshot.upTo;
      }
      if (!ops.length) break;
      server.send(JSON.stringify({ ops }));
      at = ops[ops.length - 1].pos;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Followers only listen; anything they send is ignored but a ping.
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
}
