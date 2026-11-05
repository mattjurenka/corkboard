// Every object's replica (lib/e2ee/sync.ts) in one SQLite file, a card to
// a row, so a brain with thousands of entries writes only what changed, not
// all of itself, on every change. The queue is a row per op, matched by id
// and nonce: a push deletes what was acknowledged, a reseal replaces what
// it sealed again.
//
// A replica still in the JSON file the keystore used to keep
// (replicas/<object>.json) is moved in the first time it's opened.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { NewOp } from "../lib/e2ee/wire";
import type { ReplicaStore, Saved } from "../lib/e2ee/sync";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS replicas (object TEXT PRIMARY KEY, cursor INTEGER NOT NULL, seq INTEGER NOT NULL, epoch INTEGER, clock INTEGER NOT NULL, rejected TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (object TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (object, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox (object TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, nonce TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (object, id)) WITHOUT ROWID;
`;

type Meta = { cursor: number; seq: number; epoch: number | null; clock: number; rejected: string };

export class ReplicaDb {
  private db: Database;

  constructor(readonly path: string) {
    // Made readable only by this user before SQLite opens it; its -wal
    // and -shm take the same mode.
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // legacy: the JSON file this object's replica may still be in.
  store(object: string, legacy?: string): ReplicaStore {
    return {
      load: async () => {
        const s = this.load(object);
        if (s || !legacy || !existsSync(legacy)) return s;
        let old: Saved;
        try {
          old = JSON.parse(readFileSync(legacy, "utf8"));
        } catch {
          return undefined;
        }
        this.save(object, old);
        rmSync(legacy, { force: true });
        return this.load(object);
      },
      save: async (s, changed) => this.save(object, s, changed),
    };
  }

  private load(object: string): Saved | undefined {
    const m = this.db.query<Meta, [string]>("SELECT cursor, seq, epoch, clock, rejected FROM replicas WHERE object = ?").get(object);
    if (!m) return undefined;
    const cards: Saved["state"]["cards"] = {};
    for (const r of this.db.query<{ id: string; state: string }, [string]>("SELECT id, state FROM cards WHERE object = ?").all(object)) cards[r.id] = JSON.parse(r.state);
    const outbox = this.db
      .query<{ op: string }, [string]>("SELECT op FROM outbox WHERE object = ? ORDER BY seq")
      .all(object)
      .map((r) => JSON.parse(r.op) as NewOp);
    return { cursor: m.cursor, seq: m.seq, ...(m.epoch !== null && { epoch: m.epoch }), state: { cards, clock: m.clock }, outbox, rejected: JSON.parse(m.rejected) };
  }

  private save(object: string, s: Saved, changed?: ReadonlySet<string>) {
    this.db.transaction(() => {
      this.db.run("INSERT OR REPLACE INTO replicas (object, cursor, seq, epoch, clock, rejected) VALUES (?, ?, ?, ?, ?, ?)", [
        object,
        s.cursor,
        s.seq,
        s.epoch ?? null,
        s.state.clock,
        JSON.stringify(s.rejected),
      ]);
      const put = this.db.prepare("INSERT OR REPLACE INTO cards (object, id, state) VALUES (?, ?, ?)");
      if (!changed) {
        this.db.run("DELETE FROM cards WHERE object = ?", [object]);
        for (const [id, c] of Object.entries(s.state.cards)) put.run(object, id, JSON.stringify(c));
      } else
        for (const id of changed) {
          const c = s.state.cards[id];
          if (c) put.run(object, id, JSON.stringify(c));
          else this.db.run("DELETE FROM cards WHERE object = ? AND id = ?", [object, id]);
        }
      const had = new Map(
        this.db
          .query<{ id: string; nonce: string }, [string]>("SELECT id, nonce FROM outbox WHERE object = ?")
          .all(object)
          .map((r) => [r.id, r.nonce]),
      );
      const queued = this.db.prepare("INSERT OR REPLACE INTO outbox (object, id, seq, nonce, op) VALUES (?, ?, ?, ?, ?)");
      for (const o of s.outbox) {
        if (had.get(o.id) !== o.nonce) queued.run(object, o.id, o.seq, o.nonce, JSON.stringify(o));
        had.delete(o.id);
      }
      const gone = this.db.prepare("DELETE FROM outbox WHERE object = ? AND id = ?");
      for (const id of had.keys()) gone.run(object, id);
    })();
  }
}
