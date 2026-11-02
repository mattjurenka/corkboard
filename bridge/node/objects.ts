// Which objects the node keeps a replica of. For now the names come from
// the command line and the node's config (--board KEY, --brain NAME, and
// config.json's boards and brains), each object's id and key derived from
// the root as `e2ee push-board` derives them. When lib/e2ee has the
// account's index object (the plan's "The index"), and shared objects, this
// is the one file that reads them instead: the rest of the node sees only
// the list below.
//
// Records are generic (merge.ts's cards): a board's are its cards; a
// brain's are `brain` (its settings), `note:<id>` and `entry:<id>`.

import { type BoardState, type Op, apply, empty } from "../../lib/e2ee/merge";
import { objectId, objectKey } from "../../lib/e2ee/keys";

export type NodeObject = {
  kind: "board" | "brain";
  // A board's key, a brain's name.
  name: string;
  // Its log's id on the relay.
  object: string;
  key: Uint8Array;
  // Whose log it is, when it's shared with this account by another; absent, ours.
  owner?: string;
};

export type Wanted = { boards: string[]; brains: string[] };

export function listObjects(root: Uint8Array, want: Wanted): NodeObject[] {
  const out: NodeObject[] = [];
  for (const name of new Set(want.boards)) out.push({ kind: "board", name, object: objectId(root, "board", name), key: objectKey(root, "board", name) });
  for (const name of new Set(want.brains)) out.push({ kind: "brain", name, object: objectId(root, "brain", name), key: objectKey(root, "brain", name) });
  return out;
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
