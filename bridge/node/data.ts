// The replicas as the Worker's API had them: a board's records as cards
// (lib/model/cards.ts's Card, with its log), a brain's as its settings,
// notes and log entries (memory.ts's). Reads merge from the replica each
// time; writes are changes to it, which replicas.ts pushes.
//
// Where the Worker's objects had versions and refused a stale write, a
// replica merges per field, last write winning, so an update here never
// conflicts. A note still has a version, counted up by each write, for
// note_write's check, which only holds on this node.

import { type AgentState, type Card, type Fields, type LogEntry, type Priority, type Status, Invalid, fields as checkFields } from "../../lib/model/cards";
import { createHash } from "node:crypto";
import { DAY_STARTS_HOUR, type Note, type NoteInput, today } from "../../lib/model/plans";
import type { CardChange, MergedCard } from "../../lib/e2ee/merge";
import { b64url } from "../../lib/e2ee/wire";
import { random } from "../../lib/e2ee/keys";
import { BRAIN_RECORD, ROLLUP_RECORD, VECTOR_PREFIX, entryRecord, noteRecord, recordOf, vectorRecord } from "./objects";
import type { Replicas } from "./replicas";

export { Invalid };

export type FullCard = Card & { log: LogEntry[] };
export type Entry = { id: string; at: string; day: string; who: string; text: string };
export type BrainSettings = { name: string; title: string; description: string; default: boolean; [k: string]: unknown };

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// An imported entry's id (importEntries): its time, and a hash of its id where it came from.
export const importedEntryId = (from: string, at: string) => `${Date.parse(at).toString(36)}-${createHash("sha256").update(from).digest("base64url").slice(0, 10)}`;

const CARD_FIELDS = ["title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies", "description", "extra", "created", "updated", "archived"];

function asCard(m: MergedCard, version: number): FullCard {
  const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const extra = m.extra && typeof m.extra === "object" && !Array.isArray(m.extra) ? (m.extra as Record<string, unknown>) : {};
  // Fields the card files had that the Worker's model doesn't name go in extra, as an import puts them.
  for (const [k, v] of Object.entries(m)) if (k !== "id" && k !== "log" && !CARD_FIELDS.includes(k) && !(k in extra)) extra[k] = v;
  return {
    id: m.id,
    title: s("title") ?? m.id,
    status: (s("status") ?? "backlog") as Status,
    agent: s("agent"),
    agent_state: s("agent_state") as AgentState | null,
    attention: s("attention"),
    priority: s("priority") as Priority | null,
    ordinal: typeof m.ordinal === "number" ? m.ordinal : null,
    labels: Array.isArray(m.labels) ? (m.labels as string[]) : [],
    dependencies: Array.isArray(m.dependencies) ? (m.dependencies as string[]) : [],
    description: s("description") ?? "",
    extra,
    created: s("created") ?? "",
    updated: s("updated") ?? "",
    archived: s("archived"),
    version,
    log: m.log.map((e, i) => ({ seq: i + 1, ...e })),
  };
}

// A card's ids are a prefix and a number, TASK-12; a new one takes the
// board's commonest prefix and the next number. Two devices making a card at
// once can land on the same id and merge into one: the gap the plan names.
function nextId(ids: string[]): string {
  const counts = new Map<string, number>();
  let max = new Map<string, number>();
  for (const id of ids) {
    const m = id.match(/^([A-Z]+)-(\d+)$/);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    max.set(m[1], Math.max(max.get(m[1]) ?? 0, Number(m[2])));
  }
  const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "TASK";
  return `${prefix}-${(max.get(prefix) ?? 0) + 1}`;
}

export class Data {
  constructor(
    readonly replicas: Replicas,
    readonly timeZone: string,
  ) {}

  today() {
    return today(this.timeZone);
  }

  private replica(kind: "board" | "brain", name: string) {
    const r = this.replicas.get(kind, name);
    if (!r) throw new Invalid(`no ${kind} ${name} on this node`);
    return r;
  }

  // Boards ------------------------------------------------------------------------

  boards(): { key: string; cards: number }[] {
    return this.replicas.objects("board").map((o) => ({ key: o.name, cards: this.cards(o.name).length }));
  }

  // On the board: not archived. all: those too.
  cards(board: string, all = false): FullCard[] {
    const rep = this.replica("board", board);
    const state = rep.state.cards;
    return rep
      .cards()
      .map((m) => asCard(m, Math.max(0, ...Object.values(state[m.id]?.fields ?? {}).map((f) => f.stamp.clock))))
      .filter((c) => all || !c.archived);
  }

  card(board: string, id: string): FullCard {
    const c = this.cards(board, true).find((c) => c.id === id);
    if (!c) throw new Invalid(`no card ${id}`);
    return c;
  }

  async createCard(board: string, input: Fields): Promise<FullCard> {
    const f = checkFields(input);
    if (!f.title) throw new Invalid("a card needs a title");
    const id = nextId(this.cards(board, true).map((c) => c.id));
    const t = now();
    const set = { status: "backlog", agent: null, agent_state: null, attention: null, priority: null, ordinal: null, labels: [], dependencies: [], description: "", extra: {}, ...f, created: t, updated: t, archived: null };
    await this.replicas.change("board", board, { t: "card", card: id, set });
    return this.card(board, id);
  }

  async updateCard(board: string, id: string, input: Fields): Promise<FullCard> {
    this.card(board, id);
    const f = checkFields(input);
    if (Object.keys(f).length) await this.replicas.change("board", board, { t: "card", card: id, set: { ...f, updated: now() } });
    return this.card(board, id);
  }

  async archive(board: string, id: string, archived: boolean): Promise<FullCard> {
    this.card(board, id);
    await this.replicas.change("board", board, { t: "card", card: id, set: { archived: archived ? now() : null, updated: now() } });
    return this.card(board, id);
  }

  async appendLog(board: string, id: string, who: string, note: string): Promise<LogEntry> {
    this.card(board, id);
    if (!note.trim()) throw new Invalid("note must be a non-empty string");
    await this.replicas.change("board", board, { t: "log", card: id, entry: { at: now(), who, note: note.trim() } });
    const log = this.card(board, id).log;
    return log[log.length - 1];
  }

  // Brains ------------------------------------------------------------------------

  brains(): BrainSettings[] {
    return this.replicas.objects("brain").map((o) => this.brain(o.name));
  }

  brain(name: string): BrainSettings {
    const rep = this.replica("brain", name);
    const b = rep.cards().find((c) => c.id === BRAIN_RECORD);
    const { id: _, log: __, ...f } = b ?? { id: "", log: [] };
    return { title: name, description: "", default: false, ...f, name };
  }

  // The brain the user's own clients remember in: the one whose settings say
  // so, else the first the node was given. Not an archived one.
  defaultBrain(): string | undefined {
    const all = this.brains().filter((b) => !b.archived);
    return (all.find((b) => b.default === true) ?? all[0])?.name;
  }

  // A brain's settings, the fields given set (null clears one). One brain is
  // the default, so making this one it unmakes the rest.
  async putBrain(name: string, set: Record<string, unknown>): Promise<BrainSettings> {
    // updated moves on every change, a second on if it's this second's, so
    // the form's stale check (app.ts) sees two edits within one apart.
    const after = (was: unknown) => {
      const t = now();
      return typeof was === "string" && t <= was ? new Date(Date.parse(was) + 1000).toISOString().replace(/\.\d+Z$/, "Z") : t;
    };
    if (set.default === true)
      for (const b of this.brains()) if (b.name !== name && b.default === true) await this.replicas.change("brain", b.name, { t: "card", card: BRAIN_RECORD, set: { default: false, updated: after(b.updated) } });
    const was = this.brains().find((b) => b.name === name)?.updated;
    await this.replicas.change("brain", name, { t: "card", card: BRAIN_RECORD, set: { ...set, updated: after(was) } });
    return this.brain(name);
  }

  private records(brain: string) {
    return this.replica("brain", brain)
      .cards()
      .map((m) => ({ m, r: recordOf(m.id) }));
  }

  notes(brain: string): Note[] {
    return this.records(brain)
      .filter((x) => x.r?.type === "note" && typeof x.m.title === "string")
      .map(({ m, r }) => ({
        id: r!.id,
        kind: m.kind as Note["kind"],
        title: String(m.title),
        body: String(m.body ?? ""),
        created: String(m.created ?? ""),
        updated: String(m.updated ?? ""),
        version: Number(m.version) || 1,
        ...(typeof m.path === "string" ? { path: m.path } : {}),
      }));
  }

  note(brain: string, id: string): Note | undefined {
    return this.notes(brain).find((n) => n.id === id);
  }

  // Written whole; with a version, only over that one (0: only if new).
  async putNote(brain: string, id: string, n: NoteInput, version?: number): Promise<Note> {
    const was = this.note(brain, id);
    if (version !== undefined && (was?.version ?? 0) !== version) throw new Invalid(`note ${id} is at version ${was?.version ?? 0}, not ${version}`);
    if (was && was.kind === n.kind && was.title === n.title && was.body === n.body && (n.path === undefined || n.path === was.path)) return was;
    const t = now();
    const set: Record<string, unknown> = { kind: n.kind, title: n.title, body: n.body, updated: t, version: (was?.version ?? 0) + 1, ...(was ? {} : { created: t }) };
    if (n.path !== undefined) set.path = n.path;
    await this.replicas.change("brain", brain, { t: "card", card: noteRecord(id), set });
    return this.note(brain, id)!;
  }

  // A note as another store kept it (move.ts, from the Worker): its own
  // times and version, over any here that's older.
  async importNote(brain: string, n: Note): Promise<boolean> {
    const was = this.note(brain, n.id);
    if (was && (was.version ?? 0) >= (n.version ?? 1) && was.updated >= n.updated) return false;
    const set: Record<string, unknown> = { kind: n.kind, title: n.title, body: n.body, created: n.created, updated: n.updated, version: n.version ?? 1 };
    if (n.path) set.path = n.path;
    await this.replicas.change("brain", brain, { t: "card", card: noteRecord(n.id), set });
    return true;
  }

  async appendNote(brain: string, id: string, who: string, text: string): Promise<Note> {
    const n = this.note(brain, id);
    if (!n) throw new Invalid(`no note ${id}; write it first`);
    const line = `- ${now()} ${who}: ${text.trim().replace(/\n/g, "\n  ")}`;
    return this.putNote(brain, id, { kind: n.kind, title: n.title, body: n.body.replace(/\n*$/, "") + (n.body.trim() ? "\n" : "") + line + "\n" });
  }

  entries(brain: string, from?: string, to = from): Entry[] {
    return this.records(brain)
      .filter((x) => x.r?.type === "entry" && typeof x.m.text === "string")
      .map(({ m, r }) => ({ id: r!.id, at: String(m.at ?? ""), day: String(m.day ?? ""), who: String(m.who ?? ""), text: String(m.text) }))
      .filter((e) => from === undefined || (e.day >= from && e.day <= to!))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  // The day an instant is on, as entries are (the day turns over at 4am).
  dayOf(at: string) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone }).format(new Date(Date.parse(at) - DAY_STARTS_HOUR * 3600_000));
  }

  // Entries from one source (an episode's bullets), each kept once however
  // often it's written: its id is its time, its place in the list (so those
  // at one time keep their order) and a hash of its key.
  async addEntries(brain: string, list: { at: string; who: string; text: string; key: string }[]): Promise<number> {
    const have = new Set(this.entries(brain).map((e) => e.id));
    const changes: CardChange[] = [];
    for (const [i, e] of list.entries()) {
      const id = `${Date.parse(e.at).toString(36)}-${String(i).padStart(2, "0")}${createHash("sha256").update(e.key).digest("base64url").slice(0, 8)}`;
      if (have.has(id)) continue;
      have.add(id);
      changes.push({ t: "card", card: entryRecord(id), set: { at: e.at, day: this.dayOf(e.at), who: e.who, text: e.text.trim() } });
    }
    if (changes.length) await this.replicas.change("brain", brain, ...changes);
    return changes.length;
  }

  // Entries as another store kept them, by their ids there (move.ts's
  // worker:<id>), with their days as they were: each kept once.
  async importEntries(brain: string, list: { from: string; at: string; day: string; who: string; text: string }[]): Promise<number> {
    const have = new Set(this.entries(brain).map((e) => e.id));
    const changes: CardChange[] = [];
    for (const e of list) {
      const id = importedEntryId(e.from, e.at);
      if (have.has(id)) continue;
      have.add(id);
      changes.push({ t: "card", card: entryRecord(id), set: { at: e.at, day: e.day, who: e.who, text: e.text } });
    }
    if (changes.length) await this.replicas.change("brain", brain, ...changes);
    return changes.length;
  }

  // The last day rolled up into the memory, by any machine of the account.
  rolled(brain: string): string | undefined {
    const r = this.replica("brain", brain)
      .cards()
      .find((c) => c.id === ROLLUP_RECORD);
    return typeof r?.through === "string" ? r.through : undefined;
  }

  async setRolled(brain: string, through: string) {
    await this.replicas.change("brain", brain, { t: "card", card: ROLLUP_RECORD, set: { through } });
  }

  // A text's embedding as some device of the account made it (embed.ts's
  // quantized form), by its hash; dropped ones are null.
  vector(brain: string, hash: string): { q: string; s: number } | undefined {
    const f = this.replica("brain", brain).state.cards[vectorRecord(hash)]?.fields;
    return typeof f?.q?.value === "string" && typeof f.s?.value === "number" ? { q: f.q.value, s: f.s.value } : undefined;
  }

  vectorHashes(brain: string): string[] {
    const cards = this.replica("brain", brain).state.cards;
    return Object.keys(cards)
      .filter((id) => id.startsWith(VECTOR_PREFIX) && typeof cards[id].fields.q?.value === "string")
      .map((id) => id.slice(VECTOR_PREFIX.length));
  }

  async putVectors(brain: string, add: { hash: string; q: string; s: number }[], drop: string[] = []) {
    const changes: CardChange[] = [
      ...add.map((v) => ({ t: "card" as const, card: vectorRecord(v.hash), set: { q: v.q, s: v.s } })),
      ...drop.map((h) => ({ t: "card" as const, card: vectorRecord(h), set: { q: null, s: null } })),
    ];
    if (changes.length) await this.replicas.change("brain", brain, ...changes);
  }

  // An entry's id sorts by when it was made (two in one millisecond in
  // the order they were made), and is random past that, so two devices
  // never make the same one.
  private made = 0;
  async remember(brain: string, who: string, text: string): Promise<Entry> {
    const e = { at: now(), day: this.today(), who, text: text.trim() };
    this.made = Math.max(Date.now(), this.made + 1);
    const id = `${this.made.toString(36)}-${b64url(random(6))}`;
    await this.replicas.change("brain", brain, { t: "card", card: entryRecord(id), set: e });
    return { id, ...e };
  }
}
