// Merging a board's ops, once decrypted: each card field is the value of the
// latest write to it, latest by a Lamport clock, then device, then op id,
// so every replica that has the same ops has the same board, whatever order
// they came in and however often. A card's log only grows: its entries are
// kept by op id and read in clock order.
//
// Concurrent edits to one field keep one of them, not both. That's enough for
// titles and statuses; a body two people type into at once would want a
// CRDT of its own (Automerge), later.

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
type CardState = { fields: Record<string, FieldState>; log: Record<string, { stamp: Stamp; entry: LogEntry }> };
export type BoardState = { cards: Record<string, CardState>; clock: number };

export const empty = (): BoardState => ({ cards: {}, clock: 0 });

// A record's id: a card's, or a brain's note:<id> and entry:<id>.
const CARD = /^[\w.:-]{1,64}$/;

// Applies one op (opened, with its id); false if it's not one this
// understands, which is skipped, not fatal: a newer client may write more.
export function apply(state: BoardState, id: string, op: Op): boolean {
  const c = op?.change;
  if (op?.v !== 1 || !Number.isSafeInteger(op.clock) || op.clock < 0 || typeof op.device !== "string" || !c || typeof c.card !== "string" || !CARD.test(c.card)) return false;
  const stamp: Stamp = { clock: op.clock, device: op.device, op: id };
  state.clock = Math.max(state.clock, op.clock);
  // Setting nothing makes no record: what a fresh log's first op is, to
  // give a snapshot a position to cover (Replica.seed).
  if (c.t === "card" && c.set && typeof c.set === "object" && !Object.keys(c.set).length) return true;
  const card = (state.cards[c.card] ??= { fields: {}, log: {} });
  if (c.t === "card") {
    if (!c.set || typeof c.set !== "object") return false;
    for (const [k, value] of Object.entries(c.set)) {
      if (k === "log" || k === "id" || k === "__proto__") continue;
      const had = card.fields[k];
      if (!had || compare(stamp, had.stamp) > 0) card.fields[k] = { value, stamp };
    }
    return true;
  }
  if (c.t === "log") {
    const e = c.entry;
    if (!e || typeof e.note !== "string") return false;
    card.log[id] ??= { stamp, entry: { at: String(e.at ?? ""), who: String(e.who ?? ""), note: e.note } };
    return true;
  }
  return false;
}

export type MergedCard = { id: string; log: LogEntry[]; [field: string]: unknown };

// The board as plain cards, keys and cards in a fixed order, so two
// replicas' JSON is equal exactly when their boards are.
export function cards(state: BoardState): MergedCard[] {
  return Object.keys(state.cards)
    .sort()
    .map((id) => {
      const c = state.cards[id];
      const out: MergedCard = { id, log: [] };
      for (const k of Object.keys(c.fields).sort()) out[k] = c.fields[k].value;
      out.log = Object.values(c.log)
        .sort((a, b) => compare(a.stamp, b.stamp))
        .map((l) => l.entry);
      return out;
    });
}
