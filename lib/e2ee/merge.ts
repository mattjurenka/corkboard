// Merging a board's ops, once decrypted: each card field is the value of the
// latest write to it, latest by a Lamport clock, then device, then op id,
// so every replica that has the same ops has the same board, whatever order
// they came in and however often. A card's log only grows: its entries are
// kept by op id and read in clock order.
//
// Concurrent edits to one field keep one of them, not both. That's enough for
// titles and statuses; a body two people type into at once would want a
// CRDT of its own (Automerge), later.

import { type Dict, dict } from "../dict";

export type Stamp = { clock: number; device: string; op: string };

export const compare = (a: Stamp, b: Stamp) =>
  a.clock - b.clock || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || (a.op < b.op ? -1 : a.op > b.op ? 1 : 0);

export type LogEntry = { at: string; who: string; note: string };

// What an op says, inside its encryption. set: fields of a card (anything
// but log); log: one entry onto it.
export type CardChange = { t: "card"; card: string; set: Record<string, unknown> } | { t: "log"; card: string; entry: LogEntry };

// An op once opened: the change, with the clock and device it was made with.
export type Op = { v: 1; clock: number; device: string; change: CardChange };

type FieldState = { value: unknown; stamp: Stamp };
type LogState = { stamp: Stamp; entry: LogEntry };
// Ids and field names are the writer's to choose, so each map is a Dict:
// "constructor" or "__proto__" is a card or a field like any other.
type CardState = { fields: Dict<FieldState>; log: Dict<LogState> };
export type BoardState = { cards: Dict<CardState>; clock: number };

export const empty = (): BoardState => ({ cards: dict(), clock: 0 });
const newCard = (): CardState => ({ fields: dict(), log: dict() });

// A state as it's kept (JSON, a structured clone, a snapshot): plain
// objects, its maps Dicts again once through stateOf.
export type KeptState = { clock: number; cards: Record<string, { fields?: Record<string, FieldState>; log?: Record<string, LogState> }> };

export function stateOf(s: KeptState): BoardState {
  const cards = dict<CardState>();
  for (const [id, c] of Object.entries(s.cards)) if (c && typeof c === "object") cards[id] = { fields: dict(c.fields ?? {}), log: dict(c.log ?? {}) };
  return { cards, clock: s.clock };
}

// A record's id: a card's, or a brain's note:<id> and entry:<id>.
const CARD = /^[\w.:-]{1,64}$/;

// Applies one op (opened, with its id); false if it's not one this
// understands, which is skipped, not fatal: a newer client may write more.
export function apply(state: BoardState, id: string, op: Op): boolean {
  const c = op?.change;
  if (op?.v !== 1 || !Number.isSafeInteger(op.clock) || op.clock < 0 || typeof op.device !== "string" || !c || typeof c.card !== "string" || !CARD.test(c.card))
    return false;
  const stamp: Stamp = { clock: op.clock, device: op.device, op: id };
  state.clock = Math.max(state.clock, op.clock);
  // Setting nothing makes no record: what a fresh log's first op is, to
  // give a snapshot a position to cover (Replica.seed).
  if (c.t === "card" && c.set && typeof c.set === "object" && !Object.keys(c.set).length) return true;
  const card = state.cards[c.card] ?? (state.cards[c.card] = newCard());
  if (c.t === "card") {
    if (!c.set || typeof c.set !== "object") return false;
    for (const [k, value] of Object.entries(c.set)) {
      if (k === "log" || k === "id") continue;
      const had = card.fields[k];
      if (!had || compare(stamp, had.stamp) > 0) card.fields[k] = { value, stamp };
    }
    return true;
  }
  if (c.t === "log") {
    const e = c.entry;
    if (!e || typeof e.note !== "string") return false;
    if (!card.log[id]) card.log[id] = { stamp, entry: { at: String(e.at ?? ""), who: String(e.who ?? ""), note: e.note } };
    return true;
  }
  return false;
}

// Another replica's state merged into this one, as if its ops were applied
// here: a snapshot, taken without losing what this replica has past it
// (its own ops already pushed, that the snapshot came too soon for).
export function join(into: BoardState, from: KeptState) {
  into.clock = Math.max(into.clock, from.clock);
  for (const [id, c] of Object.entries(from.cards)) {
    if (!CARD.test(id) || !c || typeof c !== "object") continue;
    const card = into.cards[id] ?? (into.cards[id] = newCard());
    for (const [k, f] of Object.entries(c.fields ?? {})) {
      if (!isStamp(f?.stamp)) continue;
      const had = card.fields[k];
      if (!had || compare(f.stamp, had.stamp) > 0) card.fields[k] = f;
    }
    for (const [op, l] of Object.entries(c.log ?? {})) if (isStamp(l?.stamp) && typeof l.entry?.note === "string" && !card.log[op]) card.log[op] = l;
  }
}

const isStamp = (s: Stamp | undefined): s is Stamp => !!s && Number.isSafeInteger(s.clock) && typeof s.device === "string" && typeof s.op === "string";

// A Dict, its fields being the writer's to name.
export type MergedCard = Dict<unknown> & { id: string; log: LogEntry[] };

// The board as plain cards, keys and cards in a fixed order, so two
// replicas' JSON is equal exactly when their boards are.
export function cards(state: BoardState): MergedCard[] {
  return Object.keys(state.cards)
    .sort()
    .map((id) => {
      const c = state.cards[id];
      const out = Object.assign(dict<unknown>(), { id, log: [] as LogEntry[] }) as MergedCard;
      for (const k of Object.keys(c.fields).sort()) out[k] = c.fields[k].value;
      out.log = Object.values(c.log)
        .sort((a, b) => compare(a.stamp, b.stamp))
        .map((l) => l.entry);
      return out;
    });
}
