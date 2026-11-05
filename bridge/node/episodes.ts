// A brain's episodes: its sessions' transcripts, as their hooks sent them
// (POST /memory/episodes), kept on the machine that recorded them and never
// synced: up to 16 MB each, too big for an op, and read only by the
// consolidator, which runs here (.agent/plans/local-memory.md). In the
// node's own SQLite, <state>/node/memory.db, readable only by the user.
//
// The same transcript twice (a retried hook) is kept once. A transcript
// only grows (compaction adds to the file, it doesn't cut it), so a newer
// one of a session replaces any of it not yet consolidated: a session
// resumed turn after turn is kept once, not once a turn.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

export const EPISODE_MAX = 16_000_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, brain TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL, trigger TEXT NOT NULL,
  at TEXT NOT NULL, bytes INTEGER NOT NULL, transcript TEXT NOT NULL, consolidated INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodes_brain ON episodes (brain, consolidated, at);
CREATE TABLE IF NOT EXISTS consolidated_sessions (brain TEXT NOT NULL, session TEXT NOT NULL, through TEXT NOT NULL, PRIMARY KEY (brain, session));
CREATE TABLE IF NOT EXISTS meta (brain TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (brain, key));
`;

export type Episode = { id: string; session: string; agent: string; trigger: string; at: string; bytes: number; consolidated: boolean; attempts: number };

export class TooBig extends Error {}

export class Episodes {
  private db: Database;
  // Called when one is added, so the consolidator can wait for quiet.
  onAdded?: (brain: string) => void;

  constructor(path = ":memory:") {
    if (path !== ":memory:" && !existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    this.db = new Database(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  add(brain: string, e: { session: string; agent: string; trigger: string; transcript: string }): { id: string; added: boolean } {
    if (e.transcript.length > EPISODE_MAX) throw new TooBig(`a transcript is at most ${EPISODE_MAX} characters`);
    const id = createHash("sha256").update(`${brain}\n${e.session}\n${e.transcript}`).digest("hex").slice(0, 32);
    if (this.db.query("SELECT 1 FROM episodes WHERE id = ?").get(id)) return { id, added: false };
    this.db.transaction(() => {
      this.db.run("DELETE FROM episodes WHERE brain = ? AND session = ? AND consolidated = 0", [brain, e.session]);
      this.db.run("INSERT INTO episodes (id, brain, session, agent, trigger, at, bytes, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        id,
        brain,
        e.session,
        e.agent,
        e.trigger,
        new Date().toISOString(),
        e.transcript.length,
        e.transcript,
      ]);
    })();
    this.onAdded?.(brain);
    return { id, added: true };
  }

  count(brain: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM episodes WHERE brain = ?").get(brain)?.n ?? 0;
  }

  // Newest first (oldest first, for the consolidator); pending, those not
  // yet consolidated.
  list(brain: string, limit = 50, pending = false, oldest = false): Episode[] {
    return this.db
      .query<Omit<Episode, "consolidated"> & { consolidated: number }, [string, number]>(
        `SELECT id, session, agent, trigger, at, bytes, consolidated, attempts FROM episodes WHERE brain = ?${pending ? " AND consolidated = 0" : ""} ORDER BY at ${oldest ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(brain, limit)
      .map((r) => ({ ...r, consolidated: !!r.consolidated }));
  }

  tried(brain: string, id: string) {
    this.db.run("UPDATE episodes SET attempts = attempts + 1 WHERE brain = ? AND id = ?", [brain, id]);
  }

  // The consolidator's own state for a brain: when to run, how it went.
  meta(brain: string, key: string): string | undefined {
    return this.db.query<{ value: string }, [string, string]>("SELECT value FROM meta WHERE brain = ? AND key = ?").get(brain, key)?.value;
  }

  setMeta(brain: string, key: string, value: string) {
    this.db.run("INSERT OR REPLACE INTO meta (brain, key, value) VALUES (?, ?, ?)", [brain, key, value]);
  }

  transcript(brain: string, id: string): string | undefined {
    return this.db.query<{ transcript: string }, [string, string]>("SELECT transcript FROM episodes WHERE brain = ? AND id = ?").get(brain, id)?.transcript;
  }

  // The brains with episodes waiting.
  waiting(): string[] {
    return this.db
      .query<{ brain: string }, []>("SELECT DISTINCT brain FROM episodes WHERE consolidated = 0")
      .all()
      .map((r) => r.brain);
  }

  // How far a session has been read already, by the time of its last record.
  through(brain: string, session: string): string | undefined {
    return this.db.query<{ through: string }, [string, string]>("SELECT through FROM consolidated_sessions WHERE brain = ? AND session = ?").get(brain, session)?.through;
  }

  // An episode as another store kept it (move.ts, from the Worker): its id,
  // time and whether it's consolidated, so what's done isn't done again.
  restore(brain: string, e: Omit<Episode, "attempts"> & { attempts?: number; transcript: string }): boolean {
    if (this.db.query("SELECT 1 FROM episodes WHERE id = ?").get(e.id)) return false;
    this.db.run("INSERT INTO episodes (id, brain, session, agent, trigger, at, bytes, transcript, consolidated, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      e.id,
      brain,
      e.session,
      e.agent,
      e.trigger,
      e.at,
      e.bytes,
      e.transcript,
      e.consolidated ? 1 : 0,
      e.attempts ?? 0,
    ]);
    return true;
  }

  restoreThrough(brain: string, session: string, through: string) {
    this.db.run(
      "INSERT INTO consolidated_sessions (brain, session, through) VALUES (?, ?, ?) ON CONFLICT (brain, session) DO UPDATE SET through = max(through, excluded.through)",
      [brain, session, through],
    );
  }

  // An episode done with: so is its session, up to its last record.
  finish(brain: string, id: string, session: string, through: string | null) {
    this.db.transaction(() => {
      this.db.run("UPDATE episodes SET consolidated = 1 WHERE brain = ? AND id = ?", [brain, id]);
      if (through)
        this.db.run(
          "INSERT INTO consolidated_sessions (brain, session, through) VALUES (?, ?, ?) ON CONFLICT (brain, session) DO UPDATE SET through = max(through, excluded.through)",
          [brain, session, through],
        );
    })();
  }
}
