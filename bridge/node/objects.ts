// Which objects the node keeps a replica of: those the account's index
// lists (lib/e2ee/sharing.ts), each opened at its entry's epoch under its
// entry's key, so one moved onto a random key (shared, or rotated) still
// opens. --board KEY and --brain NAME, and config.json's boards and brains,
// narrow that to the names given; a name the index doesn't have yet is
// served under its derived id and key, and goes into the index the first
// time the node writes it (replicas.ts). The rest of the node sees only the
// list below.
//
// Records are generic (merge.ts's cards): a board's are its cards; a
// brain's are `brain` (its settings), `note:<id>` and `entry:<id>`.

import { type BoardState, type Op, apply, empty } from "../../lib/e2ee/merge";
import { objectId, objectKey } from "../../lib/e2ee/keys";
import { type IndexEntry, entries, keyOf } from "../../lib/e2ee/sharing";
import type { Replica } from "../../lib/e2ee/sync";

export type NodeObject = {
  kind: "board" | "brain";
  // A board's key, a brain's name.
  name: string;
  // Its log's id on the relay.
  object: string;
  // Its key at epoch, and the way to a later epoch's.
  key: Uint8Array;
  epoch: number;
  keyOf?(epoch: number): Promise<Uint8Array | undefined>;
  // Whose log it is, when it's shared with this account by another; absent, ours.
  owner?: string;
};

export type Wanted = { boards: string[]; brains: string[] };

const served = (e: IndexEntry): e is IndexEntry & { kind: NodeObject["kind"] } => e.kind === "board" || e.kind === "brain";

// A later epoch's key, from the index as it is after a pull: an owner's
// other device moved the object on.
const indexKeys = (root: Uint8Array, index: Replica, object: string) => async (epoch: number) => {
  await index.pull().catch(() => {});
  const e = entries(index).find((x) => x.object === object);
  return e?.epoch === epoch ? keyOf(root, e) : undefined;
};

// index: the account's index, pulled; without one, the names given, derived.
export function listObjects(root: Uint8Array, want: Wanted, index?: Replica): NodeObject[] {
  const out = new Map<string, NodeObject>();
  const listed = index ? entries(index).filter(served) : [];
  const named = { board: new Set(want.boards), brain: new Set(want.brains) };
  const any = named.board.size + named.brain.size > 0;
  for (const e of listed)
    if (!any || named[e.kind].has(e.name))
      out.set(`${e.kind}/${e.name}`, { kind: e.kind, name: e.name, object: e.object, key: keyOf(root, e), epoch: e.epoch, keyOf: indexKeys(root, index!, e.object) });
  for (const kind of ["board", "brain"] as const)
    for (const name of named[kind])
      if (!out.has(`${kind}/${name}`)) out.set(`${kind}/${name}`, { kind, name, object: objectId(root, kind, name), key: objectKey(root, kind, name), epoch: 0 });
  return [...out.values()];
}

// A record id is `[\w.:-]{1,64}` once main's merge.ts has it; until then
// the colon isn't one of them, and `note.<id>` stands in for `note:<id>`.
// Asked of merge.ts itself, so the node follows it when it changes. Nothing
// encrypted has brains yet, so nothing written the old way needs moving.
const probe = (): boolean => {
  const s: BoardState = empty();
  const op: Op = { v: 1, clock: 1, device: "probe", change: { t: "card", card: "a:b", set: {} } };
  return apply(s, "probe", op);
};
export const SEP = probe() ? ":" : ".";

export const noteRecord = (id: string) => `note${SEP}${id}`;
export const entryRecord = (id: string) => `entry${SEP}${id}`;
export const BRAIN_RECORD = "brain";

// What a brain's record id is: its settings, a note or an entry, and whose id.
export function recordOf(id: string): { type: "brain" | "note" | "entry"; id: string } | undefined {
  if (id === BRAIN_RECORD) return { type: "brain", id: "" };
  const at = id.indexOf(SEP);
  const type = id.slice(0, at);
  if (at > 0 && (type === "note" || type === "entry")) return { type, id: id.slice(at + 1) };
  return undefined;
}
