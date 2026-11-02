// One encrypted object's log (LOG, named <account>/<object>): ops appended
// in the order they arrive, each { id, device, seq, nonce, ciphertext, ts }
// and the position the relay gave it. The object never decrypts anything
// and couldn't: it has no keys. It checks sizes, keeps order, makes a
// repeated push harmless (an op id it has is answered with its position),
// and sends each new op to every socket following the log, after the ones
// a socket asked to catch up on. See lib/e2ee/sync.ts for the other side.

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./board";
import { LIMITS, OPAQUE, type NewOp, type WireOp, b64url, fromB64url } from "../../lib/e2ee/wire";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  pos INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  seq INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
`;

const now = () => new Date().toISOString();

type Row = { pos: number; id: string; device: string; seq: number; nonce: ArrayBuffer; ciphertext: ArrayBuffer; ts: string };
const wire = (r: Row): WireOp => ({
  id: r.id,
  device: r.device,
  seq: r.seq,
  pos: r.pos,
  nonce: b64url(new Uint8Array(r.nonce)),
  ciphertext: b64url(new Uint8Array(r.ciphertext)),
  ts: r.ts,
});

const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });

export class Log extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private get bytes(): number {
    return (this.sql.exec("SELECT v FROM meta WHERE k = 'bytes'").toArray()[0]?.v as number) ?? 0;
  }

  head(): number {
    return (this.sql.exec("SELECT MAX(pos) AS p FROM ops").toArray()[0]?.p as number) ?? 0;
  }

  // ops as a client sends them; device: the token's, not the client's say.
  append(device: string, ops: NewOp[]): Result<{ id: string; pos: number }[]> {
    if (!Array.isArray(ops) || !ops.length) return fail(400, "ops must be a non-empty list");
    if (ops.length > LIMITS.batch) return fail(413, `at most ${LIMITS.batch} ops a push`);
    const parsed: { id: string; seq: number; nonce: Uint8Array; ciphertext: Uint8Array }[] = [];
    let bytes = 0;
    for (const o of ops) {
      if (!o || typeof o.id !== "string" || !OPAQUE.test(o.id)) return fail(400, "an op's id must be 16 to 64 base64url characters");
      if (!Number.isSafeInteger(o.seq) || o.seq < 0) return fail(400, "an op's seq must be a whole number");
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
      parsed.push({ id: o.id, seq: o.seq, nonce, ciphertext });
    }
    if (bytes > LIMITS.batchBytes) return fail(413, `a push is at most ${LIMITS.batchBytes} bytes`);
    if (this.bytes + bytes > LIMITS.log) return fail(413, "this log is full");

    const acks: { id: string; pos: number }[] = [];
    const fresh: WireOp[] = [];
    this.ctx.storage.transactionSync(() => {
      let added = 0;
      for (const o of parsed) {
        const had = this.sql.exec("SELECT pos FROM ops WHERE id = ?", o.id).toArray()[0];
        if (had) {
          acks.push({ id: o.id, pos: had.pos as number });
          continue;
        }
        const ts = now();
        const row = this.sql
          .exec("INSERT INTO ops (id, device, seq, nonce, ciphertext, ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING pos", o.id, device, o.seq, o.nonce, o.ciphertext, ts)
          .one();
        const pos = row.pos as number;
        acks.push({ id: o.id, pos });
        fresh.push({ id: o.id, device, seq: o.seq, pos, nonce: b64url(o.nonce), ciphertext: b64url(o.ciphertext), ts });
        added += o.ciphertext.length;
      }
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('bytes', ?) ON CONFLICT (k) DO UPDATE SET v = v + excluded.v", added);
    });
    if (fresh.length) this.fanOut(fresh);
    return { ok: true, value: acks };
  }

  read(since: number, limit: number = LIMITS.read): { ops: WireOp[]; head: number } {
    const n = Math.max(1, Math.min(LIMITS.read, Math.floor(limit) || LIMITS.read));
    const ops = this.sql
      .exec("SELECT * FROM ops WHERE pos > ? ORDER BY pos LIMIT ?", Math.max(0, Math.floor(since) || 0), n)
      .toArray()
      .map((r) => wire(r as unknown as Row));
    return { ops, head: this.head() };
  }

  private fanOut(ops: WireOp[]) {
    const msg = JSON.stringify({ ops });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  // A socket following the log (e2ee.ts checked who's asking): what it
  // missed since ?since=, then each op as it comes. Hibernates between.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0) || 0;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // No await between reading and accepting, so no op lands in neither.
    for (let at = since; ; ) {
      const { ops } = this.read(at);
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
