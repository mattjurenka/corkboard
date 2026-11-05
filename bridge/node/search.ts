// Memory search over the decrypted brains, as memory.ts did it in the
// Worker's SQLite: FTS5 (stemmed) for notes_search and recall, a plain scan
// for grep, and the day a question names worked out in code. The index is
// in memory (bun:sqlite), made again from a brain's replica whenever it has
// changed since the last search, so it's never stale and never on disk.
//
// Recall by meaning is an Embedder: embed.ts's, a small model run here.
// A brain's changes are embedded a minute after (by then, those another
// device made come with their vectors), and at once when a session's
// memory has been consolidated (share). Without one, recall is
// the words and the days, as the Worker's was with vectors off.

import { Database } from "bun:sqlite";
import { range } from "../../lib/model/dates";
import { DAY_STARTS_HOUR, type Note } from "../../lib/model/plans";
import type { Data, Entry } from "./data";

export type Hit = { type: "note" | "entry"; id: string; title: string; kind?: string; day?: string; at: string; snippet: string };

// What recall by meaning would be given: the brain's items, and a question;
// it answers the nearest items' keys ("note:<id>" or "entry:<id>"), best first.
// warm makes the items' vectors ahead of a question.
export type Embedder = {
  nearest(brain: string, query: string, items: { key: string; text: string }[]): Promise<string[]>;
  warm?(brain: string, items: { key: string; text: string }[]): Promise<unknown>;
};

const WARM_AFTER = 60_000;

const SCHEMA = `
CREATE VIRTUAL TABLE notes USING fts5(brain UNINDEXED, id UNINDEXED, kind UNINDEXED, updated UNINDEXED, title, body, tokenize='porter unicode61');
CREATE VIRTUAL TABLE entries USING fts5(brain UNINDEXED, id UNINDEXED, day UNINDEXED, at UNINDEXED, who UNINDEXED, text, tokenize='porter unicode61');
`;

// Each word quoted, so punctuation is a word and not query syntax. any: one
// word is enough (recall), else all must match.
const ftsQuery = (q: string, any = false) =>
  q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(any ? " OR " : " ");

export const before = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

export class Search {
  private db = new Database(":memory:");
  private dirty = new Set<string>();
  private warming = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private data: Data,
    private embedder?: Embedder,
  ) {
    this.db.exec(SCHEMA);
    for (const b of data.replicas.objects("brain")) this.dirty.add(b.name);
    data.replicas.onChange((o) => {
      if (o.kind !== "brain") return;
      this.dirty.add(o.name);
      this.warmLater(o.name);
    });
  }

  private items(brain: string) {
    return [
      ...this.data.notes(brain).map((n) => ({ key: `note:${n.id}`, text: `${n.title}\n\n${n.body}` })),
      ...this.data.entries(brain).map((e) => ({ key: `entry:${e.id}`, text: `${e.day} ${e.who}: ${e.text}` })),
    ];
  }

  // A brain's vectors made, a little after its last change.
  warmLater(brain: string, after = WARM_AFTER) {
    if (!this.embedder?.warm) return;
    clearTimeout(this.warming.get(brain));
    const t = setTimeout(() => {
      this.warming.delete(brain);
      this.share(brain).catch((e) => console.error(`node: embedding ${brain}:`, e));
    }, after);
    t.unref?.();
    this.warming.set(brain, t);
  }

  // A brain's vectors made now, for every device of the account.
  async share(brain: string) {
    clearTimeout(this.warming.get(brain));
    this.warming.delete(brain);
    await this.embedder?.warm?.(brain, this.items(brain));
  }

  private fresh(brain: string) {
    if (!this.dirty.delete(brain)) return;
    const notes = this.data.notes(brain);
    const entries = this.data.entries(brain);
    this.db.transaction(() => {
      this.db.run("DELETE FROM notes WHERE brain = ?", [brain]);
      this.db.run("DELETE FROM entries WHERE brain = ?", [brain]);
      const n = this.db.prepare("INSERT INTO notes (brain, id, kind, updated, title, body) VALUES (?, ?, ?, ?, ?, ?)");
      for (const x of notes) n.run(brain, x.id, x.kind, x.updated, x.title, x.body);
      const e = this.db.prepare("INSERT INTO entries (brain, id, day, at, who, text) VALUES (?, ?, ?, ?, ?, ?)");
      for (const x of entries) e.run(brain, x.id, x.day, x.at, x.who, x.text);
    })();
  }

  // Without a query: the newest first. With one: the best matches, each with a snippet.
  notes(brain: string, query: string | undefined, kind: string | undefined, limit: number, hidden: readonly string[] = []) {
    const q = query?.trim() ? ftsQuery(query) : "";
    if (!q)
      return this.data
        .notes(brain)
        .filter((n) => (!kind || n.kind === kind) && !hidden.includes(n.kind))
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, limit)
        .map(({ id, kind, title, updated }) => ({ id, kind, title, updated }));
    this.fresh(brain);
    const rows = this.db
      .query(
        `SELECT id, kind, title, updated, snippet(notes, 5, '[', ']', '…', 16) AS snippet FROM notes
         WHERE notes MATCH ? AND brain = ?${kind ? " AND kind = ?" : ""} ORDER BY rank LIMIT ?`,
      )
      .all(...([q, brain, ...(kind ? [kind] : []), limit * 2] as string[])) as { id: string; kind: string; title: string; updated: string; snippet: string }[];
    return rows.filter((r) => !hidden.includes(r.kind)).slice(0, limit);
  }

  private hitFor(brain: string, key: string, hidden: readonly string[]): Hit | null {
    const id = key.slice(key.indexOf(":") + 1);
    if (key.startsWith("note:")) {
      const n = this.data.note(brain, id);
      if (!n || hidden.includes(n.kind)) return null;
      return { type: "note", id: n.id, kind: n.kind, title: n.title, at: n.updated, snippet: n.body.slice(0, 240).replace(/\s+/g, " ") };
    }
    const e = this.data.entries(brain).find((e) => e.id === id);
    return e ? { type: "entry", id: e.id, title: `${e.day} ${e.who}`, day: e.day, at: e.at, snippet: e.text.slice(0, 240) } : null;
  }

  private async nearest(brain: string, query: string, hidden: readonly string[]): Promise<Hit[]> {
    if (!this.embedder) return [];
    try {
      return (await this.embedder.nearest(brain, query, this.items(brain))).map((k) => this.hitFor(brain, k, hidden)).filter((h): h is Hit => !!h);
    } catch (e) {
      console.error("node: recall by meaning failed:", e);
      return [];
    }
  }

  // memory.ts's recall: the words (notes and entries), the meaning, and the
  // day the question names, merged by reciprocal rank fusion.
  async recall(brain: string, query: string, limit: number, hidden: readonly string[] = []): Promise<Hit[]> {
    const q = ftsQuery(query, true);
    if (!q) return [];
    this.fresh(brain);
    const notes = (
      this.db
        .query(`SELECT id, kind, title, updated AS at, snippet(notes, 5, '[', ']', '…', 24) AS snippet FROM notes WHERE notes MATCH ? AND brain = ? ORDER BY rank LIMIT 50`)
        .all(q, brain) as Omit<Hit, "type">[]
    )
      .filter((r) => !hidden.includes(r.kind!))
      .map((r) => ({ type: "note" as const, ...r }));
    const entries = (
      this.db
        .query(`SELECT id, day, at, who, snippet(entries, 5, '[', ']', '…', 24) AS snippet FROM entries WHERE entries MATCH ? AND brain = ? ORDER BY rank LIMIT 50`)
        .all(q, brain) as { id: string; day: string; at: string; who: string; snippet: string }[]
    ).map((r) => ({ type: "entry" as const, id: r.id, title: `${r.day} ${r.who}`, day: r.day, at: r.at, snippet: r.snippet }));
    const days = range(query, this.data.today());
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const onDays = days
      ? this.data
          .entries(brain, days.from, days.to)
          .map((e) => ({ e, n: words.filter((w) => e.text.toLowerCase().includes(w)).length }))
          .sort((a, b) => b.n - a.n || b.e.at.localeCompare(a.e.at))
          .slice(0, 50)
          .map(({ e }) => this.hitFor(brain, `entry:${e.id}`, hidden)!)
      : [];
    const near = await this.nearest(brain, query, hidden);
    const score = new Map<string, { hit: Hit; score: number }>();
    const lists: [Hit[], number][] = [[notes, 1], [entries, 1], [near, 1], [onDays, 1.5]];
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

  // Lines containing the text, case ignored: notes newest first, then entries newest first.
  grep(brain: string, text: string, limit: number, hidden: readonly string[] = []): { where: string; line: string }[] {
    const needle = text.toLowerCase();
    if (!needle) return [];
    const out: { where: string; line: string }[] = [];
    const notes = this.data
      .notes(brain)
      .filter((n) => !hidden.includes(n.kind))
      .sort((a, b) => b.updated.localeCompare(a.updated));
    for (const n of notes)
      for (const [i, line] of n.body.split("\n").entries()) {
        if (out.length >= limit) return out;
        if (line.toLowerCase().includes(needle)) out.push({ where: `${n.id}:${i + 1}`, line });
      }
    for (const e of this.data.entries(brain).reverse()) {
      if (out.length >= limit) break;
      if (e.text.toLowerCase().includes(needle)) out.push({ where: `${e.day} ${e.who}`, line: e.text });
    }
    return out;
  }

  // memory.ts's context: who it is and who the user is, the long-term
  // memory, the goals (to those who see them), the last days' log, the day
  // records, then what else it has learned, cut to the budget.
  context(brain: string, budget: number, hidden: readonly string[] = [], days = 3): string {
    const d = this.data.today();
    const notes = this.data.notes(brain).filter((n) => !hidden.includes(n.kind));
    const core = ["soul", "user", "memory"].map((id) => notes.find((n) => n.id === id)).filter((n): n is Note => !!n);
    const goals = notes.filter((n) => n.kind === "goal").sort((a, b) => a.id.localeCompare(b.id));
    const learned = notes.filter((n) => n.kind === "memory" && !["soul", "user", "memory"].includes(n.id)).sort((a, b) => b.updated.localeCompare(a.updated));
    const dayNotes = [`day-${d}`, `day-${before(d, 1)}`].map((id) => notes.find((n) => n.id === id && n.kind === "day")).filter((n): n is Note => !!n);
    const log = this.data.entries(brain, before(d, days - 1), d);

    const sections: string[] = [];
    let left = budget;
    const add = (text: string) => {
      if (left <= 0) return;
      const t = text.length > left ? text.slice(0, Math.max(0, left - 40)) + "\n\n…(cut; recall for more)\n" : text;
      sections.push(t);
      left -= t.length;
    };
    const asNote = (n: Note) => `## ${n.title} (${n.id})\n\n${n.body.trim()}\n`;
    core.forEach((n) => add(asNote(n)));
    goals.forEach((n) => add(asNote(n)));
    if (log.length) add(`## Log, newest day first (day turns over at ${DAY_STARTS_HOUR}am)\n\n${logText(log, this.data.timeZone, true)}`);
    dayNotes.forEach((n) => add(asNote(n)));
    learned.forEach((n) => add(asNote(n)));
    return `# Memory: ${brain}, today ${d}\n\n${sections.join("\n")}`;
  }

}

// Entries as Markdown, a heading a day, each day cut to `cap` characters.
export function logText(log: Entry[], timeZone: string, newestFirst: boolean, cap = Infinity) {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  const byDay = new Map<string, Entry[]>();
  for (const e of log) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const days = [...byDay];
  if (newestFirst) days.reverse();
  return days
    .map(([day, es]) => {
      const text = es.map((e) => `- ${clock.format(new Date(e.at))} ${e.who}: ${e.text.replace(/\n/g, "\n  ")}`).join("\n");
      return `### ${day}\n\n${text.length > cap ? text.slice(0, cap) + "\n…(cut)" : text}\n`;
    })
    .join("\n");
}
