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
// brain's are `brain` (its settings), `note:<id>`, `entry:<id>`, and
// `vector:<hash>` (a text's embedding, embed.ts's, made once for every device).
// The account's "oauth" object (accountObject) is oauth.ts's: its clients,
// grants and lasting tokens, kept the same on every node. Its "day" object
// (dayObject) holds the day plans and the chat (day.ts). Its "fleet" object
// (fleetObject) what the fleet keeps sealed from the Worker (fleet.ts).

import { type BoardState, type Op, apply, empty } from "../../lib/e2ee/merge";
import { objectId, objectKey } from "../../lib/e2ee/keys";
import { type IndexEntry, entries, keyOf } from "../../lib/e2ee/sharing";
import type { Replica } from "../../lib/e2ee/sync";

export type NodeObject = {
  kind: "board" | "brain" | "account" | "day" | "fleet";
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

const served = (e: IndexEntry): e is IndexEntry & { kind: "board" | "brain" } => e.kind === "board" || e.kind === "brain";

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

// The account's own object of that name, as the index has it (moved onto a
// new key with the rest), else derived; it goes into the index the first
// time the node writes it, as a brain does.
export function accountObject(root: Uint8Array, name: string, index?: Replica, kind: "account" | "day" | "fleet" = "account"): NodeObject {
  const e = index && entries(index).find((x) => x.kind === kind && x.name === name);
  return e
    ? { kind, name, object: e.object, key: keyOf(root, e), epoch: e.epoch, keyOf: indexKeys(root, index!, e.object) }
    : { kind, name, object: objectId(root, kind, name), key: objectKey(root, kind, name), epoch: 0 };
}

// The account's one day object, the same way.
export const DAY = "day";
export const dayObject = (root: Uint8Array, index?: Replica) => accountObject(root, DAY, index, "day");
export const FLEET = "fleet";
export const fleetObject = (root: Uint8Array, index?: Replica) => accountObject(root, FLEET, index, "fleet");

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
export const vectorRecord = (hash: string) => `vector${SEP}${hash}`;
export const VECTOR_PREFIX = vectorRecord("");
// An episode handed to the node that leads (handoff.ts).
export const episodeRecord = (id: string) => `episode${SEP}${id}`;
export const EPISODE_PREFIX = episodeRecord("");
export const BRAIN_RECORD = "brain";
// The fleet object's (fleet.ts): a spawn's sealed part, a hold's secret, an
// environment's whole manifest.
export const spawnRecord = (id: string) => `spawn${SEP}${id}`;
export const holdRecord = (name: string) => `hold${SEP}${name}`;
export const environmentRecord = (name: string) => `env${SEP}${name}`;
// How far the consolidator has rolled the log up into the memory: synced,
// so two machines of the account don't both roll up the same days.
export const ROLLUP_RECORD = "rollup";

// What a brain's record id is: its settings, a note or an entry, and whose id.
export function recordOf(id: string): { type: "brain" | "note" | "entry"; id: string } | undefined {
  if (id === BRAIN_RECORD) return { type: "brain", id: "" };
  const at = id.indexOf(SEP);
  const type = id.slice(0, at);
  if (at > 0 && (type === "note" || type === "entry")) return { type, id: id.slice(at + 1) };
  return undefined;
}
