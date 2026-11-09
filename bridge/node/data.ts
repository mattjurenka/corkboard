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
import { type Block, type ChatMessage, DAY_STARTS_HOUR, type Note, type NoteInput, type Plan, type Proposal, today } from "../../lib/model/plans";
import type { CardChange, MergedCard } from "../../lib/e2ee/merge";
import { b64url } from "../../lib/e2ee/wire";
import { random } from "../../lib/e2ee/keys";
import { BRAIN_RECORD, DAY, ROLLUP_RECORD, VECTOR_PREFIX, entryRecord, noteRecord, recordOf, vectorRecord } from "./objects";
import { CHAT_PREFIX, Conflict, type FeedDevice, type Feeds, type Meditation, type Message, PLAN_PREFIX, askKey, chatRecord, feedsOf, feedsRecord, importedMessageId, meditationOf, meditationRecord, messageOf, planOf, planRecord, versionOf } from "./day";
import { BOARD_RECORD, type BoardSettings, MEDIA_PREFIX, extraOf, extraSet, isCard, isExtraField, leaseRecord, mediaRecord, newCardId, settingsOf } from "./board";
import type { Replicas } from "./replicas";

export { Conflict, Invalid };

export type FullCard = Card & { log: LogEntry[] };
// until: in milliseconds; lapsed: the leader blocked the card for it (leases.ts).
export type Lease = { agent: string; until: number; lapsed: boolean };
// A file on a card, as its extra.media lists it (the Worker's media.ts's).
export type MediaItem = { id: string; name: string; type: string; size: number; at: string; who: string };
// Its record (media.ts): the card, and its sealed pieces' blobs in order,
// under the board's key of epoch.
export type StoredMedia = MediaItem & { card: string; blobs: string[]; epoch: number };

function storedOf(m: MergedCard): StoredMedia | undefined {
  if (m.deleted || typeof m.card !== "string" || !Array.isArray(m.blobs) || typeof m.size !== "number") return;
  return { id: m.id.slice(MEDIA_PREFIX.length), card: m.card, name: String(m.name ?? ""), type: String(m.type ?? "application/octet-stream"), size: m.size, at: String(m.at ?? ""), who: String(m.who ?? ""), blobs: m.blobs as string[], epoch: Number(m.epoch) || 0 };
}
const itemOf = ({ card: _, blobs: __, epoch: ___, ...m }: StoredMedia): MediaItem => m;
export type Entry = { id: string; at: string; day: string; who: string; text: string };
export type BrainSettings = { name: string; title: string; description: string; default: boolean; [k: string]: unknown };

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// An imported entry's id (importEntries): its time, and a hash of its id where it came from.
export const importedEntryId = (from: string, at: string) => `${Date.parse(at).toString(36)}-${createHash("sha256").update(from).digest("base64url").slice(0, 10)}`;

const CARD_FIELDS = ["title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies", "description", "extra", "created", "updated", "archived", "deleted"];

// media: the card's files kept here, after any its extra had from the Worker.
function asCard(m: MergedCard, version: number, media: MediaItem[] = []): FullCard {
  const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const extra = extraOf(m);
  // Fields the card files had that the Worker's model doesn't name go in extra, as an import puts them.
  for (const [k, v] of Object.entries(m)) if (k !== "id" && k !== "log" && !CARD_FIELDS.includes(k) && !isExtraField(k) && !(k in extra)) extra[k] = v;
  if (media.length) extra.media = [...(Array.isArray(extra.media) ? (extra.media as MediaItem[]).filter((x) => !media.some((y) => y.id === x.id)) : []), ...media];
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

export class Data {
  constructor(
    readonly replicas: Replicas,
    readonly timeZone: string,
  ) {}

  today() {
    return today(this.timeZone);
  }

  private replica(kind: "board" | "brain" | "day", name: string) {
    const r = this.replicas.get(kind, name);
    if (!r) throw new Invalid(`no ${kind} ${name} on this node`);
    return r;
  }

  // Boards ------------------------------------------------------------------------

  boards(): { key: string; name: string; root: string | null; cards: number }[] {
    return this.replicas.objects("board").map((o) => {
      const s = this.board(o.name);
      return { key: o.name, name: typeof s.name === "string" ? s.name : o.name, root: typeof s.root === "string" ? s.root : null, cards: this.cards(o.name).length };
    });
  }

  // The board's own settings: its name, root, first commit, remotes and
  // each environment's root (board.ts).
  board(board: string): BoardSettings {
    return settingsOf(this.replica("board", board).cards());
  }

  // The fields given set; null clears one.
  async putBoard(board: string, set: BoardSettings): Promise<BoardSettings> {
    const had = this.board(board);
    const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => JSON.stringify(had[k] ?? null) !== JSON.stringify(v ?? null)));
    if (Object.keys(changed).length) await this.replicas.change("board", board, { t: "card", card: BOARD_RECORD, set: changed });
    return this.board(board);
  }

  // On the board: not archived. all: those too. A card's version counts
  // its files' records too, so one attached is a newer card.
  cards(board: string, all = false): FullCard[] {
    const rep = this.replica("board", board);
    const state = rep.state.cards;
    const clock = (id: string) => Math.max(0, ...Object.values(state[id]?.fields ?? {}).map((f) => f.stamp.clock));
    const records = rep.cards();
    const media = new Map<string, { items: MediaItem[]; clock: number }>();
    for (const s of this.storedMedia(records)) {
      const on = media.get(s.card) ?? (media.set(s.card, { items: [], clock: 0 }), media.get(s.card)!);
      on.items.push(itemOf(s));
      on.clock = Math.max(on.clock, clock(mediaRecord(s.id)));
    }
    return records
      .filter((m) => isCard(m.id) && !m.deleted)
      .map((m) => asCard(m, Math.max(clock(m.id), media.get(m.id)?.clock ?? 0), media.get(m.id)?.items))
      .filter((c) => all || !c.archived);
  }

  // The files kept on the board's cards, oldest first.
  private storedMedia(records: MergedCard[]): StoredMedia[] {
    return records
      .filter((m) => m.id.startsWith(MEDIA_PREFIX))
      .map(storedOf)
      .filter((s): s is StoredMedia => !!s)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  media(board: string, card?: string): StoredMedia[] {
    return this.storedMedia(this.replica("board", board).cards()).filter((s) => !card || s.card === card);
  }

  // A file on its card, with a line in the card's log; null, none (one
  // moved from the Worker, whose log has the line already).
  async addMedia(board: string, s: StoredMedia, note: string | null): Promise<MediaItem> {
    this.card(board, s.card);
    const { id, ...set } = s;
    await this.replicas.change("board", board, { t: "card", card: mediaRecord(id), set }, ...(note === null ? [] : [{ t: "log" as const, card: s.card, entry: { at: now(), who: s.who, note } }]));
    return itemOf(s);
  }

  // A card's files off it, for good (its card deleted): what they were.
  async dropMedia(board: string, card: string): Promise<StoredMedia[]> {
    const gone = this.media(board, card);
    if (gone.length) await this.replicas.change("board", board, ...gone.map((s) => ({ t: "card" as const, card: mediaRecord(s.id), set: { deleted: now() } })));
    return gone;
  }

  card(board: string, id: string): FullCard {
    const c = this.cards(board, true).find((c) => c.id === id);
    if (!c) throw new Invalid(`no card ${id}`);
    return c;
  }

  async createCard(board: string, input: Fields): Promise<FullCard> {
    const f = checkFields(input);
    if (!f.title) throw new Invalid("a card needs a title");
    // Not one a deleted card had.
    const id = newCardId(this.replica("board", board).cards().filter((m) => isCard(m.id)).map((m) => m.id));
    const t = now();
    const { extra = {}, ...rest } = f;
    const set = { status: "backlog", agent: null, agent_state: null, attention: null, priority: null, ordinal: null, labels: [], dependencies: [], description: "", ...rest, ...extraSet({}, extra), created: t, updated: t, archived: null };
    await this.replicas.change("board", board, { t: "card", card: id, set });
    return this.card(board, id);
  }

  // A given extra is the card's whole extra; only the keys that changed are written.
  async updateCard(board: string, id: string, input: Fields): Promise<FullCard> {
    const had = this.card(board, id);
    const { extra, ...f } = checkFields(input);
    const set: Record<string, unknown> = { ...f, ...(extra ? extraSet(had.extra, extra) : {}) };
    if (Object.keys(set).length) await this.replicas.change("board", board, { t: "card", card: id, set: { ...set, updated: now() } });
    return this.card(board, id);
  }

  async archive(board: string, id: string, archived: boolean): Promise<FullCard> {
    this.card(board, id);
    await this.replicas.change("board", board, { t: "card", card: id, set: { archived: archived ? now() : null, updated: now() } });
    return this.card(board, id);
  }

  // Gone for good: the record stays, as merge.ts's records do, marked so
  // nothing reads it as a card.
  async deleteCard(board: string, id: string): Promise<void> {
    this.card(board, id);
    await this.replicas.change("board", board, { t: "card", card: id, set: { deleted: now() } });
  }

  async appendLog(board: string, id: string, who: string, note: string): Promise<LogEntry> {
    this.card(board, id);
    if (!note.trim()) throw new Invalid("note must be a non-empty string");
    await this.replicas.change("board", board, { t: "log", card: id, entry: { at: now(), who, note: note.trim() } });
    const log = this.card(board, id).log;
    return log[log.length - 1];
  }

  // The claim on a working card, as leases.ts keeps it.
  lease(board: string, id: string): Lease | undefined {
    const m = this.replica("board", board)
      .cards()
      .find((c) => c.id === leaseRecord(id));
    return m && typeof m.agent === "string" && typeof m.until === "number" ? { agent: m.agent, until: m.until, lapsed: m.lapsed === true } : undefined;
  }

  async setLease(board: string, id: string, lease: Lease): Promise<void> {
    await this.replicas.change("board", board, { t: "card", card: leaseRecord(id), set: lease });
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

  // An entry's (or a message's) id sorts by when it was made (two in one
  // millisecond in the order they were made), and is random past that, so
  // two devices never make the same one. Given the newest id it's seen, it
  // sorts after that too, however wrong the clock that made either is (a
  // hybrid logical clock): an answer comes after what it answers.
  private made = 0;
  private timeId(after?: string) {
    const seen = after ? parseInt(after.split("-")[0], 36) : NaN;
    this.made = Math.max(Date.now(), this.made + 1, Number.isFinite(seen) ? seen + 1 : 0);
    return `${this.made.toString(36)}-${b64url(random(6))}`;
  }

  async remember(brain: string, who: string, text: string): Promise<Entry> {
    const e = { at: now(), day: this.today(), who, text: text.trim() };
    const id = this.timeId();
    await this.replicas.change("brain", brain, { t: "card", card: entryRecord(id), set: e });
    return { id, ...e };
  }

  // Day plans (day.ts) ------------------------------------------------------------

  private planRecord(date: string): MergedCard | undefined {
    const id = planRecord(date);
    return this.replica("day", DAY)
      .cards()
      .find((c) => c.id === id);
  }

  plan(date: string): Plan {
    return planOf(date, this.planRecord(date), versionOf(this.replica("day", DAY).state, planRecord(date)));
  }

  // The dates that have a plan, oldest first.
  planDates(): string[] {
    return this.replica("day", DAY)
      .cards()
      .filter((c) => c.id.startsWith(PLAN_PREFIX))
      .map((c) => c.id.slice(PLAN_PREFIX.length));
  }

  // With a version, only over that one, as the Worker's plans were; it
  // holds on this node only. A write from elsewhere merges per field.
  private async changePlan(date: string, version: number | null, set: Record<string, unknown>, said?: { who: string; text: string }): Promise<Plan> {
    const was = this.plan(date);
    if (version !== null && was.version !== version) throw new Conflict(`the plan for ${date} is at version ${was.version}, not ${version}`, was);
    await this.replicas.change("day", DAY, ...(Object.keys(set).length ? [{ t: "card" as const, card: planRecord(date), set }] : []), ...(said ? [{ t: "log" as const, card: planRecord(date), entry: { at: now(), who: said.who, note: said.text } }] : []));
    return this.plan(date);
  }

  // The assistant's, over the last; it answers what's been asked so far.
  async propose(date: string, proposal: Omit<Proposal, "answering" | "id">, projects?: Plan["projects"]): Promise<Plan> {
    const m = this.planRecord(date);
    const answered = Array.isArray(m?.answered) ? (m!.answered as string[]) : [];
    const asking = (m?.log ?? []).filter((e) => !answered.includes(askKey(e)));
    const set: Record<string, unknown> = { proposal: { ...proposal, id: b64url(random(9)), answering: asking.map((e) => e.note) }, answered: [...answered, ...asking.map(askKey)] };
    if (projects) set.projects = projects;
    return this.changePlan(date, null, set);
  }

  say(date: string, who: string, text: string): Promise<Plan> {
    return this.changePlan(date, null, {}, { who, text });
  }

  // The proposal (the one named, when it's named), as the user left it
  // after undoing what they didn't want, becomes the day.
  async accept(date: string, version: number | null, blocks: Block[], proposal?: string): Promise<Plan> {
    const p = this.plan(date);
    const open = this.open(p, proposal, "accept");
    return this.changePlan(date, version, {
      day: { blocks, ranked: open.ranked ?? p.day.ranked, later: open.later ?? p.day.later, inputs: open.inputs ?? p.day.inputs },
      accepted: { at: now(), proposal: open.id ?? null },
      // One from before proposals had ids is closed only by clearing it.
      ...(open.id ? {} : { proposal: null }),
    });
  }

  async discard(date: string, version: number | null, proposal?: string): Promise<Plan> {
    const open = this.open(this.plan(date), proposal, "discard");
    return this.changePlan(date, version, open.id ? { discarded: open.id } : { proposal: null });
  }

  private open(p: Plan, id: string | undefined, what: string): Proposal {
    if (!p.proposal) throw new Conflict(`there's no proposal to ${what}`, p);
    if (id !== undefined && p.proposal.id !== id) throw new Conflict(`that proposal isn't the plan's any more: there's a newer one`, p);
    return p.proposal;
  }

  // The day itself edited (a block retitled or pinned in the plan window).
  setDay(date: string, version: number | null, blocks: Block[]): Promise<Plan> {
    return this.changePlan(date, version, { day: { ...this.plan(date).day, blocks } });
  }

  // How writing the calendar went for an accept and the day it wrote
  // (calendar.ts's dayDigest), if it's still the plan's.
  async calendarWritten(date: string, accepted: string, day: string, result: { blocks: number } | { error: string }): Promise<Plan> {
    const p = this.plan(date);
    if (p.accepted !== accepted) return p;
    return this.changePlan(date, null, { calendar: { accepted, at: now(), day, ...result } });
  }

  // A plan from the Worker (move.ts), as it is there: its open proposal
  // named from its version, what's asked as entries of that day, an accept
  // that names no proposal. Only what differs is written, so a second move
  // writes nothing.
  async importPlan(p: Plan): Promise<boolean> {
    const m = this.planRecord(p.date);
    const want: Record<string, unknown> = {
      day: p.day,
      projects: p.projects,
      proposal: p.proposal && { ...p.proposal, id: `worker-${p.version}` },
      accepted: p.accepted && { at: p.accepted, proposal: null },
      ...(p.calendar && { calendar: p.calendar }),
    };
    const set = Object.fromEntries(Object.entries(want).filter(([k, v]) => JSON.stringify(m?.[k] ?? null) !== JSON.stringify(v ?? null)));
    const had = new Set((m?.log ?? []).map(askKey));
    const asked = p.asked
      .map((note, i) => ({ at: `${p.date}T00:00:00.${String(i).padStart(3, "0")}Z`, who: "user", note }))
      .filter((e) => !had.has(askKey(e)));
    const changes = [...(Object.keys(set).length ? [{ t: "card" as const, card: planRecord(p.date), set }] : []), ...asked.map((entry) => ({ t: "log" as const, card: planRecord(p.date), entry }))];
    if (changes.length) await this.replicas.change("day", DAY, ...changes);
    return changes.length > 0;
  }

  // Meditation (day.ts) -------------------------------------------------------------

  meditation(date: string): Meditation {
    const id = meditationRecord(date);
    return meditationOf(
      date,
      this.replica("day", DAY)
        .cards()
        .find((c) => c.id === id),
    );
  }

  // Started where it was left, or paused with what's run banked; either
  // again is nothing.
  async meditate(date: string, change: "start" | "pause"): Promise<Meditation> {
    const was = this.meditation(date);
    if (change === "start" ? was.running || was.elapsed >= was.goal : !was.running) return was;
    await this.replicas.change("day", DAY, { t: "card", card: meditationRecord(date), set: { banked: was.elapsed, since: change === "start" ? new Date().toISOString() : null } });
    return this.meditation(date);
  }

  // Feeds (day.ts) ------------------------------------------------------------------

  feeds(date: string): Feeds {
    const id = feedsRecord(date);
    return feedsOf(
      date,
      this.replica("day", DAY)
        .cards()
        .find((c) => c.id === id),
    );
  }

  // A device's count only grows, so one that lost its own can't give time back.
  async countFeeds(date: string, device: FeedDevice, seconds: number): Promise<Feeds> {
    const was = this.feeds(date);
    if (seconds <= was[device]) return was;
    await this.replicas.change("day", DAY, { t: "card", card: feedsRecord(date), set: { [device]: seconds } });
    return this.feeds(date);
  }

  // Chat (day.ts) -------------------------------------------------------------------

  private messages(): Message[] {
    return this.replica("day", DAY)
      .cards()
      .filter((c) => c.id.startsWith(CHAT_PREFIX))
      .map(messageOf)
      .filter((m): m is Message => !!m);
  }

  // The messages after an id, oldest first; with none, the newest `limit`.
  chat(after?: string, limit = 50): Message[] {
    const all = this.messages();
    return after ? all.filter((m) => m.id > after).slice(0, limit) : all.slice(-limit);
  }

  message(id: string): Message | undefined {
    return this.messages().find((m) => m.id === id);
  }

  // byUser: the user's own, from the phone; else a brain's.
  async post(who: string, text: string, byUser = false): Promise<Message> {
    const id = this.timeId(this.messages().reduce((a, m) => (m.id > a ? m.id : a), ""));
    await this.replicas.change("day", DAY, { t: "card", card: chatRecord(id), set: { at: now(), who, text, by_user: byUser, delivered: null } });
    return this.message(id)!;
  }

  // The user's own message, changed or taken back before it's passed on.
  private pending(id: string): Message {
    const m = this.message(id);
    if (!m || !m.by_user) throw new Invalid(`no message ${id}`);
    if (m.delivered) throw new Conflict("Pepper has it already");
    return m;
  }

  async edit(id: string, text: string): Promise<Message> {
    this.pending(id);
    await this.replicas.change("day", DAY, { t: "card", card: chatRecord(id), set: { text } });
    return this.message(id)!;
  }

  async unsay(id: string): Promise<void> {
    this.pending(id);
    await this.replicas.change("day", DAY, { t: "card", card: chatRecord(id), set: { deleted: now() } });
  }

  // pepperd passes it on: from now it's as it was said. Again, it's as it was.
  async deliver(id: string): Promise<Message> {
    const m = this.message(id);
    if (!m || !m.by_user) throw new Invalid(`no message ${id}`);
    if (!m.delivered) await this.replicas.change("day", DAY, { t: "card", card: chatRecord(id), set: { delivered: now() } });
    return this.message(id)!;
  }

  // The Worker's messages (move.ts), with their times, each once. Their
  // ids here are day.ts's importedMessageId.
  async importChat(messages: ChatMessage[]): Promise<number> {
    const have = new Set(this.messages().map((m) => m.id));
    const changes = messages
      .map((m) => ({ id: importedMessageId(m.id, m.at), m }))
      .filter(({ id }) => !have.has(id))
      .map(({ id, m }) => ({ t: "card" as const, card: chatRecord(id), set: { at: m.at, who: m.who, text: m.text, by_user: m.by_user, delivered: m.delivered } }));
    if (changes.length) await this.replicas.change("day", DAY, ...changes);
    return changes.length;
  }
}
