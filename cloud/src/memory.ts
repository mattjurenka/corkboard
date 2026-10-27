// One brain's memory: what every agent of the brain remembers, wherever it
// runs. See .agent/plans/memory.md.
//
// One object per user and brain (`<user>/<brain>`), so each brain's memory
// has one writer: this object, which runs one request at a time. Agents
// never rewrite what another wrote; they add.
//
//   notes     the brain's documents: the soul, what it knows, decisions,
//             projects, day records. Versioned; a write naming a stale
//             version gets a 409 with the note as it is.
//   entries   its log, a line at a time, each on a day (the day turns over
//             at 4am, as plans do). The day-to-day of what happened.
//   episodes  whole session transcripts, as the agents' hooks send them at
//             the end of a session and before it compacts. Kept, never
//             summarised away: the record everything else is made from.
//
// Pepper's brain started as the notes in its user's object (user.ts); the
// first open() brings them over.

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./board";
import type { Env } from "./index";
import { DAY_STARTS_HOUR, type Note, type NoteInput, today } from "./plans";
import { range } from "./dates";
import { chunks, embed, namespaceOf, sha, vectorId } from "./vectors";

// The brains there are: a memory is one of these.
export const BRAINS = ["pepper", "work"] as const;
export type Brain = (typeof BRAINS)[number];

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string, note?: Note): Result<never> => ({ ok: false, status, error, note });

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export type Entry = { id: number; at: string; day: string; who: string; text: string };
export type Hit = { type: "note" | "entry"; id: string; title: string; kind?: string; day?: string; at: string; snippet: string };

// SQLite keeps a value to 2 MB; a transcript is stored in parts under it.
const PART = 1_000_000;
// And one episode to this, so a runaway session can't fill the object.
const EPISODE_MAX = 16_000_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid', tokenize='porter unicode61');
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
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_day ON entries (day);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, trigger TEXT NOT NULL,
  at TEXT NOT NULL, bytes INTEGER NOT NULL, parts INTEGER NOT NULL, consolidated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS episode_parts (episode TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (episode, seq));
CREATE TABLE IF NOT EXISTS vector_queue (item TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vectors (item TEXT PRIMARY KEY, hash TEXT NOT NULL, chunks INTEGER NOT NULL);
`;

// A search as FTS5 reads it: each word quoted, so punctuation is a word and
// not query syntax. any: one word is enough (recall), else all must match.
const ftsQuery = (q: string, any = false) =>
  q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(any ? " OR " : " ");

const notIn = (column: string, hidden: readonly string[]) =>
  hidden.length ? { sql: ` AND ${column} NOT IN (${hidden.map(() => "?").join(", ")})`, args: [...hidden] } : { sql: "", args: [] as string[] };

// The day `days` before `day`, as YYYY-MM-DD.
const before = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class Memory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // Columns added since the first objects were made.
    const has = (table: string, column: string) => this.sql.exec(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`, table, column).toArray().length > 0;
    if (!has("notes", "path")) this.sql.exec("ALTER TABLE notes ADD COLUMN path TEXT");
    if (!has("entries", "key")) this.sql.exec("ALTER TABLE entries ADD COLUMN key TEXT");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS entries_key ON entries (key)");
  }

  private meta(key: string): string | undefined {
    return this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value as string | undefined;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  // Called before anything else on each request (memoryOf in mcp.ts): who
  // this is, and for Pepper's brain, the user's notes brought over once.
  // Nothing else runs here until that's done.
  async open(user: string, brain: string): Promise<void> {
    if (this.meta("brain")) return this.backfill();
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.meta("brain")) return;
      if (brain === "pepper") {
        const notes = (await this.env.USER.get(this.env.USER.idFromName(user)).exportNotes()) as Note[];
        for (const n of notes)
          this.sql.exec(
            "INSERT OR IGNORE INTO notes (id, kind, title, body, created, updated) VALUES (?, ?, ?, ?, ?, ?)",
            n.id,
            n.kind,
            n.title,
            n.body,
            n.created,
            n.updated,
          );
      }
      this.setMeta("user", user);
      this.setMeta("brain", brain);
    });
    this.backfill();
  }

  private today() {
    return today(this.env.TIMEZONE);
  }

  // Notes -----------------------------------------------------------------------------

  private findNote(id: string): Note | undefined {
    return this.sql.exec("SELECT * FROM notes WHERE id = ?", id).toArray()[0] as Note | undefined;
  }

  // Without a query: the newest first. With one: the best matches, each with
  // a snippet around what matched. Never a note of the hidden kinds.
  notes(query: string | undefined, kind: string | undefined, limit: number, hidden: readonly string[] = []) {
    const q = query?.trim() ? ftsQuery(query) : "";
    const where: string[] = [];
    const args: string[] = [];
    if (kind) where.push("n.kind = ?"), args.push(kind);
    if (hidden.length) where.push(`n.kind NOT IN (${hidden.map(() => "?").join(", ")})`), args.push(...hidden);
    if (!q) {
      const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      return this.sql.exec(`SELECT n.id, n.kind, n.title, n.updated FROM notes n${cond} ORDER BY n.updated DESC LIMIT ?`, ...args, limit).toArray();
    }
    const select = `SELECT n.id, n.kind, n.title, n.updated, snippet(notes_fts, 1, '[', ']', '…', 16) AS snippet
      FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?`;
    const cond = where.map((w) => ` AND ${w}`).join("");
    return this.sql.exec(`${select}${cond} ORDER BY rank LIMIT ?`, q, ...args, limit).toArray();
  }

  note(id: string): Result<Note> {
    const n = this.findNote(id);
    return n ? ok(n) : fail(404, `no note ${id}`);
  }

  // Written whole. With a version, only over that version: a stale one gets
  // a 409 and the note as it is, so two writers can't lose each other's
  // changes. Without one, whatever is there is replaced. A write that
  // changes nothing (a sync of an unchanged file) leaves it as it was.
  putNote(id: string, n: NoteInput, version?: number): Result<Note> {
    const was = this.findNote(id);
    if (version !== undefined && (was?.version ?? 0) !== version)
      return fail(409, `note ${id} is at version ${was?.version ?? 0}, not ${version}`, was);
    if (was && was.kind === n.kind && was.title === n.title && was.body === n.body && (n.path === undefined || n.path === was.path)) return ok(was);
    const t = now();
    this.sql.exec(
      `INSERT INTO notes (id, kind, title, body, path, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body,
         path = coalesce(excluded.path, path), updated = excluded.updated, version = version + 1`,
      id,
      n.kind,
      n.title,
      n.body,
      n.path ?? null,
      t,
      t,
    );
    this.dirty(`note:${id}`);
    return ok(this.findNote(id)!);
  }

  // One line added to a note, as "- <time> <who>: <text>": a day's log, say.
  appendNote(id: string, who: string, text: string): Result<Note> {
    const n = this.findNote(id);
    if (!n) return fail(404, `no note ${id}; write it first`);
    const line = `- ${now()} ${who}: ${text.trim().replace(/\n/g, "\n  ")}`;
    this.sql.exec(
      "UPDATE notes SET body = ?, updated = ?, version = version + 1 WHERE id = ?",
      n.body.replace(/\n*$/, "") + (n.body.trim() ? "\n" : "") + line + "\n",
      now(),
      id,
    );
    this.dirty(`note:${id}`);
    return ok(this.findNote(id)!);
  }

  deleteNote(id: string): void {
    this.sql.exec("DELETE FROM notes WHERE id = ?", id);
    this.dirty(`note:${id}`);
  }

  // Entries ---------------------------------------------------------------------------

  remember(who: string, text: string): Entry {
    const e = this.sql
      .exec("INSERT INTO entries (at, day, who, text) VALUES (?, ?, ?, ?) RETURNING *", now(), this.today(), who, text.trim())
      .one() as Entry;
    this.dirty(`entry:${e.id}`);
    return e;
  }

  // Entries written elsewhere first (a vault's daily logs), each with its own
  // time and day and a key that is the same each time it's sent, so a sync
  // adds only what's new. Returns how many were.
  addEntries(list: { at: string; day: string; who: string; text: string; key: string }[]): number {
    // Counted, not taken from rowsWritten, which an ignored insert adds to too.
    const count = () => this.sql.exec("SELECT count(*) AS n FROM entries").one().n as number;
    const was = count();
    const last = (this.sql.exec("SELECT coalesce(max(id), 0) AS n FROM entries").one().n as number);
    this.ctx.storage.transactionSync(() => {
      for (const e of list)
        this.sql.exec("INSERT OR IGNORE INTO entries (at, day, who, text, key) VALUES (?, ?, ?, ?, ?)", e.at, e.day, e.who, e.text, e.key);
      this.sql.exec("INSERT OR IGNORE INTO vector_queue (item) SELECT 'entry:' || id FROM entries WHERE id > ?", last);
    });
    this.wake();
    return count() - was;
  }

  // A day's entries, or the days from `from` to `to`, oldest first.
  entries(from: string, to = from): Entry[] {
    return this.sql.exec("SELECT * FROM entries WHERE day BETWEEN ? AND ? ORDER BY id", from, to).toArray() as Entry[];
  }

  // Vectors ---------------------------------------------------------------------------
  //
  // What changed waits in vector_queue, as "note:<id>" or "entry:<id>", and
  // the object's alarm embeds it after the write has been answered, so no
  // write waits on Workers AI. `vectors` says what each item was last
  // embedded from (a hash) and in how many chunks, so an unchanged item is
  // skipped and a shorter one's old chunks are removed.

  private vectorsOn() {
    return this.env.MEMORY_VECTORS !== "off" && !!this.env.AI && !!this.env.VECTORS;
  }

  private dirty(item: string) {
    this.sql.exec("INSERT OR IGNORE INTO vector_queue (item) VALUES (?)", item);
    this.wake();
  }

  private wake() {
    if (!this.vectorsOn()) return;
    void this.ctx.storage.getAlarm().then((a) => {
      if (a === null) return this.ctx.storage.setAlarm(Date.now() + 2000);
    });
  }

  // Everything, once: a memory made before vectors, or one just opened.
  private backfill() {
    if (!this.vectorsOn() || this.meta("vectors") === "1") return;
    this.sql.exec("INSERT OR IGNORE INTO vector_queue (item) SELECT 'note:' || id FROM notes");
    this.sql.exec("INSERT OR IGNORE INTO vector_queue (item) SELECT 'entry:' || id FROM entries");
    this.setMeta("vectors", "1");
    this.wake();
  }

  private async namespace() {
    return namespaceOf(this.meta("user") ?? "", this.meta("brain") ?? "");
  }

  // What an item is embedded as, or null for one that's gone.
  private embeddable(item: string): string[] | null {
    const [type, id] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
    if (type === "note") {
      const n = this.findNote(id);
      return n ? chunks(n.title, n.body) : null;
    }
    const e = this.sql.exec("SELECT day, who, text FROM entries WHERE id = ?", Number(id)).toArray()[0];
    return e ? [`${e.day} ${e.who}: ${e.text}`.slice(0, 6000)] : null;
  }

  async alarm() {
    if (!this.vectorsOn()) return;
    const items = this.sql.exec("SELECT item FROM vector_queue LIMIT 40").toArray().map((r) => r.item as string);
    if (!items.length) return;
    const ns = await this.namespace();
    const upserts: VectorizeVector[] = [];
    const removed: string[] = [];
    const texts: string[] = [];
    const done: { item: string; hash: string; chunks: number }[] = [];
    for (const item of items) {
      const was = this.sql.exec("SELECT hash, chunks FROM vectors WHERE item = ?", item).toArray()[0] as { hash: string; chunks: number } | undefined;
      const pieces = this.embeddable(item);
      const hash = pieces ? await sha(pieces.join("\u0000")) : "";
      if (was && was.hash === hash) continue;
      const count = pieces?.length ?? 0;
      for (let i = count; i < (was?.chunks ?? 0); i++) removed.push(await vectorId(ns, item, i));
      for (let i = 0; i < count; i++) {
        upserts.push({ id: await vectorId(ns, item, i), values: [], namespace: ns, metadata: { item, chunk: i } });
        texts.push(pieces![i]);
      }
      done.push({ item, hash, chunks: count });
    }
    // A failure is thrown so the alarm retries, but logged first, since
    // after its last retry nothing else says why the queue stopped.
    try {
      if (texts.length) {
        const vectors = await embed(this.env.AI, texts);
        upserts.forEach((u, i) => (u.values = vectors[i]));
        for (let i = 0; i < upserts.length; i += 500) await this.env.VECTORS.upsert(upserts.slice(i, i + 500));
      }
      if (removed.length) await this.env.VECTORS.deleteByIds(removed);
    } catch (e) {
      console.error(`vectors: ${ns}: ${items.length} items, ${texts.length} texts, longest ${Math.max(0, ...texts.map((t) => t.length))}: ${e instanceof Error ? e.stack ?? e.message : e}`);
      throw e;
    }
    this.ctx.storage.transactionSync(() => {
      for (const d of done) {
        if (d.chunks) this.sql.exec("INSERT INTO vectors (item, hash, chunks) VALUES (?, ?, ?) ON CONFLICT (item) DO UPDATE SET hash = excluded.hash, chunks = excluded.chunks", d.item, d.hash, d.chunks);
        else this.sql.exec("DELETE FROM vectors WHERE item = ?", d.item);
      }
      for (const item of items) this.sql.exec("DELETE FROM vector_queue WHERE item = ?", item);
    });
    if (this.sql.exec("SELECT 1 FROM vector_queue LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  // How many items wait to be embedded, and how many are: for a sync to
  // report, and to see the backfill through. Asking wakes a queue whose
  // alarm has given up.
  async vectorState() {
    const queued = this.sql.exec("SELECT count(*) AS n FROM vector_queue").one().n as number;
    let alarm = await this.ctx.storage.getAlarm();
    // An alarm a minute overdue is one that isn't going to run.
    if (queued && this.vectorsOn() && (alarm === null || alarm < Date.now() - 60_000)) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      alarm = await this.ctx.storage.getAlarm();
    }
    return {
      on: this.vectorsOn(),
      queued,
      embedded: this.sql.exec("SELECT count(*) AS n FROM vectors").one().n as number,
      alarm: alarm === null ? null : new Date(alarm).toISOString(),
    };
  }

  // The items nearest the question's meaning, best first, one hit each.
  private async nearest(query: string, hidden: readonly string[]): Promise<Hit[]> {
    if (!this.vectorsOn()) return [];
    try {
      const [vector] = await embed(this.env.AI, [query]);
      const r = await this.env.VECTORS.query(vector, { topK: 40, namespace: await this.namespace(), returnMetadata: "all" });
      const seen = new Set<string>();
      const hits: Hit[] = [];
      for (const m of r.matches) {
        const item = String(m.metadata?.item ?? "");
        if (!item || seen.has(item)) continue;
        seen.add(item);
        const hit = this.hitFor(item, hidden);
        if (hit) hits.push(hit);
      }
      return hits;
    } catch (e) {
      // Recall still answers from the words when Workers AI or Vectorize
      // doesn't.
      console.error("memory: vector recall failed:", e);
      return [];
    }
  }

  private hitFor(item: string, hidden: readonly string[]): Hit | null {
    const id = item.slice(item.indexOf(":") + 1);
    if (item.startsWith("note:")) {
      const n = this.findNote(id);
      if (!n || hidden.includes(n.kind)) return null;
      return { type: "note", id: n.id, kind: n.kind, title: n.title, at: n.updated, snippet: n.body.slice(0, 240).replace(/\s+/g, " ") };
    }
    const e = this.sql.exec("SELECT * FROM entries WHERE id = ?", Number(id)).toArray()[0] as Entry | undefined;
    return e ? { type: "entry", id: String(e.id), title: `${e.day} ${e.who}`, day: e.day, at: e.at, snippet: e.text.slice(0, 240) } : null;
  }

  // Recall ----------------------------------------------------------------------------

  // What the question is about, from up to four lists merged by reciprocal
  // rank fusion (each hit scores weight/(60 + its rank) in each list), the
  // newer first on a tie:
  //   notes and entries that contain any of its words (FTS, stemmed),
  //   whatever is nearest its meaning (vectors),
  //   and, when it names a day ("yesterday", "last Tuesday", "Oct 24"),
  //   that day's entries, worked out here rather than by a model.
  async recall(query: string, limit: number, hidden: readonly string[] = []): Promise<Hit[]> {
    const q = ftsQuery(query, true);
    if (!q) return [];
    const h = notIn("n.kind", hidden);
    const notes = this.sql
      .exec(
        `SELECT n.id, n.kind, n.title, n.updated AS at, snippet(notes_fts, 1, '[', ']', '…', 24) AS snippet
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?${h.sql} ORDER BY rank LIMIT 50`,
        q,
        ...h.args,
      )
      .toArray()
      .map((r) => ({ type: "note" as const, ...(r as any) }));
    const entries = this.sql
      .exec(
        `SELECT e.id, e.day, e.at, e.who, snippet(entries_fts, 0, '[', ']', '…', 24) AS snippet
         FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ? ORDER BY rank LIMIT 50`,
        q,
      )
      .toArray()
      .map((r: any) => ({ type: "entry" as const, id: String(r.id), title: `${r.day} ${r.who}`, day: r.day, at: r.at, snippet: r.snippet }));
    // The day the question names, its entries in order: those with its words
    // first, then the rest of the day.
    const days = range(query, this.today());
    const onDays = days
      ? (this.entries(days.from, days.to)
          .map((e) => ({ e, words: query.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && e.text.toLowerCase().includes(w)).length }))
          .sort((a, b) => b.words - a.words || b.e.id - a.e.id)
          .slice(0, 50)
          .map(({ e }) => this.hitFor(`entry:${e.id}`, hidden)!) as Hit[])
      : [];
    const near = await this.nearest(query, hidden);
    const score = new Map<string, { hit: Hit; score: number }>();
    const lists: [Hit[], number][] = [[notes as Hit[], 1], [entries as Hit[], 1], [near, 1], [onDays, 1.5]];
    for (const [list, weight] of lists)
      list.forEach((hit, rank) => {
        const key = `${hit.type}:${hit.id}`;
        const s = score.get(key) ?? { hit, score: 0 };
        s.score += weight / (60 + rank);
        score.set(key, s);
      });
    return [...score.values()]
      .sort((a, b) => b.score - a.score || b.hit.at.localeCompare(a.hit.at))
      .slice(0, limit)
      .map((s) => s.hit);
  }

  // Lines containing the text, case ignored, in the notes and the entries:
  // the plain search an agent reaches for when it knows the words.
  grep(text: string, limit: number, hidden: readonly string[] = []): { where: string; line: string }[] {
    const needle = text.toLowerCase();
    if (!needle) return [];
    const like = `%${needle.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const h = notIn("kind", hidden);
    const out: { where: string; line: string }[] = [];
    for (const n of this.sql.exec(`SELECT id, body FROM notes WHERE lower(body) LIKE ? ESCAPE '\\'${h.sql} ORDER BY updated DESC`, like, ...h.args)) {
      (n.body as string).split("\n").forEach((line, i) => {
        if (out.length < limit && line.toLowerCase().includes(needle)) out.push({ where: `${n.id}:${i + 1}`, line });
      });
      if (out.length >= limit) return out;
    }
    for (const e of this.sql.exec("SELECT id, day, who, text FROM entries WHERE lower(text) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?", like, limit - out.length))
      out.push({ where: `${e.day} ${e.who}`, line: e.text as string });
    return out;
  }

  // Episodes --------------------------------------------------------------------------

  // A session's transcript, as its hook sent it. The same transcript twice
  // (a retried hook) is kept once. A transcript only grows (compaction adds
  // to the file, it doesn't cut it), so a newer one of a session replaces
  // any not yet consolidated: a phone chat resumed turn after turn is kept
  // once, not once a turn.
  async addEpisode(e: { session: string; agent: string; trigger: string; transcript: string }): Promise<Result<{ id: string; added: boolean }>> {
    if (e.transcript.length > EPISODE_MAX) return fail(413, `a transcript is at most ${EPISODE_MAX} characters`);
    const id = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${e.session}\n${e.transcript}`))).slice(0, 32);
    if (this.sql.exec("SELECT 1 FROM episodes WHERE id = ?", id).toArray().length) return ok({ id, added: false });
    const parts = Math.max(1, Math.ceil(e.transcript.length / PART));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM episode_parts WHERE episode IN (SELECT id FROM episodes WHERE session = ? AND consolidated = 0)", e.session);
      this.sql.exec("DELETE FROM episodes WHERE session = ? AND consolidated = 0", e.session);
      this.sql.exec(
        "INSERT INTO episodes (id, session, agent, trigger, at, bytes, parts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        e.session,
        e.agent,
        e.trigger,
        now(),
        e.transcript.length,
        parts,
      );
      for (let i = 0; i < parts; i++)
        this.sql.exec("INSERT INTO episode_parts (episode, seq, text) VALUES (?, ?, ?)", id, i, e.transcript.slice(i * PART, (i + 1) * PART));
    });
    return ok({ id, added: true });
  }

  // Not yet consolidated first: what the consolidator (step 4) works from.
  episodes(limit: number, pending = false) {
    return this.sql
      .exec(`SELECT id, session, agent, trigger, at, bytes, consolidated FROM episodes${pending ? " WHERE consolidated = 0" : ""} ORDER BY at DESC LIMIT ?`, limit)
      .toArray();
  }

  episode(id: string): Result<{ id: string; transcript: string }> {
    const rows = this.sql.exec("SELECT text FROM episode_parts WHERE episode = ? ORDER BY seq", id).toArray();
    return rows.length ? ok({ id, transcript: rows.map((r) => r.text).join("") }) : fail(404, `no episode ${id}`);
  }

  // Context ---------------------------------------------------------------------------

  // What a session of the brain starts with, as Markdown, within `budget`
  // characters, in this order: who it is and who it works for (the soul, the
  // user), its long-term memory (the note `memory`), its goals (to those who
  // may see them), the last days' log (newest day first) and day records,
  // then the other memory notes, newest first. What doesn't fit is cut from
  // the end, and is a recall away.
  context(budget: number, hidden: readonly string[] = [], days = 3): string {
    const d = this.today();
    const h = notIn("kind", hidden);
    const pick = (sql: string, ...args: unknown[]) => this.sql.exec(sql, ...args).toArray() as unknown as Note[];
    const core = pick(`SELECT * FROM notes WHERE id IN ('soul', 'user', 'memory')${h.sql} ORDER BY CASE id WHEN 'soul' THEN 0 WHEN 'user' THEN 1 ELSE 2 END`, ...h.args);
    const goals = pick(`SELECT * FROM notes WHERE kind = 'goal'${h.sql} ORDER BY id`, ...h.args);
    const learned = pick(`SELECT * FROM notes WHERE kind = 'memory' AND id NOT IN ('soul', 'user', 'memory')${h.sql} ORDER BY updated DESC`, ...h.args);
    const dayNotes = pick(`SELECT * FROM notes WHERE kind = 'day' AND id IN (?, ?)${h.sql} ORDER BY id DESC`, `day-${d}`, `day-${before(d, 1)}`, ...h.args);
    const log = this.entries(before(d, days - 1), d);

    const sections: string[] = [];
    let left = budget;
    const add = (text: string) => {
      if (left <= 0) return;
      const t = text.length > left ? text.slice(0, Math.max(0, left - 40)) + "\n\n…(cut; recall for more)\n" : text;
      sections.push(t);
      left -= t.length;
    };
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: this.env.TIMEZONE, hour: "2-digit", minute: "2-digit" });
    const asNote = (n: Note) => `## ${n.title} (${n.id})\n\n${n.body.trim()}\n`;
    core.forEach((n) => add(asNote(n)));
    goals.forEach((n) => add(asNote(n)));
    if (log.length) {
      const byDay = new Map<string, Entry[]>();
      for (const e of log) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
      const text = [...byDay]
        .reverse()
        .map(([day, es]) => `### ${day}\n\n${es.map((e) => `- ${clock.format(new Date(e.at))} ${e.who}: ${e.text.replace(/\n/g, "\n  ")}`).join("\n")}\n`)
        .join("\n");
      add(`## Log, newest day first (day turns over at ${DAY_STARTS_HOUR}am)\n\n${text}`);
    }
    dayNotes.forEach((n) => add(asNote(n)));
    learned.forEach((n) => add(asNote(n)));
    return `# Memory: ${this.meta("brain") ?? "?"}, today ${d}\n\n${sections.join("\n")}`;
  }
}
