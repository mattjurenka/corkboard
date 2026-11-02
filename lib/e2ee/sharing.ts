// What a client does of .agent/plans/e2ee.md's "Next": the account's index,
// sharing an object with another account, and the account key's rotation.
// The relay's side is cloud/src/e2ee.ts; the byte layouts are wire.ts's.
// android/.../e2ee/Sharing.kt is the same, in Kotlin.

import { sha256 } from "@noble/hashes/sha2.js";
import { openSealed, sealTo } from "./box";
import { type Device, certify, checkCert, signGrant, signRotation, verify } from "./device";
import { type AccountKeys, type ObjectKind, KINDS, accountKeys, newRoot, objectId, objectKey, random } from "./keys";
import { type BoardState, type CardChange, type MergedCard, cards } from "./merge";
import type { Relay } from "./relay";
import type { Replica } from "./sync";
import {
  type AccountView,
  type DeviceCert,
  type Grant,
  type Role,
  type Rotated,
  type Signed,
  b64url,
  creationBytes,
  fromB64url,
  fromUtf8,
  isGrant,
  isRotation,
  grantBytes,
  rotationBytes,
  utf8,
} from "./wire";

// The index -----------------------------------------------------------------------
//
// One object of kind index (name ""), its id and key derived from the root
// like any other's: a record per object the account has, its id the
// object's, fields { kind, name, epoch, key? }. key is there when the
// object's key isn't derived from this root (a random one, after sharing
// or rotation).

export type IndexEntry = { object: string; kind: Exclude<ObjectKind, "index">; name: string; epoch: number; key?: string };

export const indexId = (root: Uint8Array) => objectId(root, "index", "");
export const indexKey = (root: Uint8Array) => objectKey(root, "index", "");

// The object's key at its epoch: its own, or derived.
export const keyOf = (root: Uint8Array, e: IndexEntry) => (e.key ? fromB64url(e.key) : objectKey(root, e.kind, e.name));

function entryOf(c: MergedCard): IndexEntry | undefined {
  const kind = c.kind as IndexEntry["kind"];
  if (!KINDS.includes(kind) || (kind as ObjectKind) === "index" || typeof c.name !== "string") return;
  const epoch = Number.isSafeInteger(c.epoch) ? (c.epoch as number) : 0;
  return { object: c.id, kind, name: c.name, epoch, ...(typeof c.key === "string" && { key: c.key }) };
}

export const entries = (index: Replica) => index.cards().flatMap((c) => entryOf(c) ?? []);

// Written the first time an object is pushed, and when its key changes.
export async function remember(index: Replica, e: IndexEntry) {
  const had = entries(index).find((x) => x.object === e.object);
  if (had && had.epoch === e.epoch && had.key === e.key && had.name === e.name) return;
  await index.change({ t: "card", card: e.object, set: { kind: e.kind, name: e.name, epoch: e.epoch, key: e.key ?? null } });
}

// Accounts as the relay shows them -------------------------------------------------

// The key an account signs with now, if its proof holds: its creation signed
// by its id, then each rotation by the key before it. undefined if it doesn't.
export function currentKey(v: AccountView, id: string): string | undefined {
  const c = v.proof?.creation;
  if (v.id !== id || c?.body?.account !== id || !verify(id, creationBytes(c.body), c.sig)) return;
  let key = id;
  let box = c.body.box;
  for (const r of v.proof.rotations ?? []) {
    if (!isRotation(r.body) || r.body.account !== id || r.body.from !== key || !verify(key, rotationBytes(r.body), r.sig)) return;
    key = r.body.to;
    box = r.body.box;
  }
  return key === v.key && box === v.box ? key : undefined;
}

// Sharing: the member's side ------------------------------------------------------

// What's sealed to a member: the object's key at an epoch.
type SharedKey = { v: 1; owner: string; object: string; kind: ObjectKind; name: string; epoch: number; key: string };

export type Shared = { grant: Signed<Grant>; sealed: string };

// An object another account shares with this one, its key opened.
export type SharedObject = { owner: string; object: string; kind: ObjectKind; name: string; role: Role; epoch: number; key: Uint8Array };

// Opens a grant to this account (me: its keys now; myId: its id), checked:
// signed by the owner's key now, the box the one signed for, and what's in
// it the grant's object and epoch.
export function openGrant(me: AccountKeys, myId: string, g: Shared, owner: AccountView): SharedObject {
  const b = g.grant.body;
  if (!isGrant(b) || b.member !== myId) throw new Error("that grant isn't to this account");
  const ownerKey = currentKey(owner, b.owner);
  if (!ownerKey) throw new Error(`${b.owner}'s keys don't chain to its id`);
  if (!verify(ownerKey, grantBytes(b), g.grant.sig)) throw new Error("that grant isn't signed by its owner");
  const sealed = fromB64url(g.sealed);
  if (b64url(sha256(sealed)) !== b.wrapped) throw new Error("that grant's key isn't the one its owner signed for");
  const k = JSON.parse(fromUtf8(openSealed(me.box.secret, me.box.public, sealed))) as SharedKey;
  if (k.owner !== b.owner || k.object !== b.object || k.epoch !== b.epoch || !KINDS.includes(k.kind)) throw new Error("that grant's key is for something else");
  return { owner: b.owner, object: b.object, kind: k.kind, name: k.name, role: b.role, epoch: b.epoch, key: fromB64url(k.key) };
}

// Every object shared with this account, newest grant per object; the
// ones that don't check out are left out, with why.
export async function sharedWithMe(relay: Relay, me: AccountKeys, myId: string): Promise<{ objects: SharedObject[]; bad: string[] }> {
  const views = new Map<string, Promise<AccountView>>();
  const newest = new Map<string, Shared>();
  for (const g of await relay.shared()) {
    const k = `${g.grant.body.owner}/${g.grant.body.object}`;
    if ((newest.get(k)?.grant.body.at ?? -1) < g.grant.body.at) newest.set(k, g);
  }
  const objects: SharedObject[] = [];
  const bad: string[] = [];
  for (const g of newest.values()) {
    const owner = g.grant.body.owner;
    try {
      if (!views.has(owner)) views.set(owner, relay.accountView(owner));
      objects.push(openGrant(me, myId, g, await views.get(owner)!));
    } catch (e) {
      bad.push(`${g.grant.body.object}: ${(e as Error).message}`);
    }
  }
  return { objects, bad };
}

// A member's replica's keyOf: a later epoch's key, from the grant the owner
// sealed for it.
export const memberKeys = (relay: Relay, me: AccountKeys, myId: string, owner: string, object: string) => async (epoch: number) =>
  (await sharedWithMe(relay, me, myId)).objects.find((o) => o.owner === owner && o.object === object && o.epoch === epoch)?.key;

// Sharing: the owner's side --------------------------------------------------------

// The grant and the sealed key for one member.
export function grantTo(
  owner: AccountKeys,
  ownerId: string,
  member: AccountView,
  o: { object: string; kind: ObjectKind; name: string; role: Role; epoch: number; key: Uint8Array },
  at = Date.now(),
): Shared {
  if (!currentKey(member, member.id)) throw new Error(`${member.id}'s keys don't chain to its id`);
  const payload: SharedKey = { v: 1, owner: ownerId, object: o.object, kind: o.kind, name: o.name, epoch: o.epoch, key: b64url(o.key) };
  const sealed = sealTo(fromB64url(member.box), utf8(JSON.stringify(payload)));
  const g: Grant = { v: 1, owner: ownerId, object: o.object, member: member.id, role: o.role, epoch: o.epoch, wrapped: b64url(sha256(sealed)), at };
  return { grant: signGrant(owner, g), sealed: b64url(sealed) };
}

// Shares an object: first onto a random key at the next epoch if it's still
// on its derived one, so the owner's rotation never has to change a shared
// object's id; then the grant.
export async function share(
  relay: Relay,
  root: Uint8Array,
  ownerId: string,
  index: Replica,
  rep: Replica,
  o: { kind: IndexEntry["kind"]; name: string; member: AccountView; role: Role },
) {
  let entry = entries(index).find((x) => x.object === rep.object) ?? { object: rep.object, kind: o.kind, name: o.name, epoch: rep.currentEpoch };
  if (!entry.key) {
    const key = random(32);
    await rep.rekey(key);
    entry = { ...entry, epoch: rep.currentEpoch, key: b64url(key) };
  }
  await remember(index, entry);
  await index.push();
  const g = grantTo(accountKeys(root), ownerId, o.member, { ...entry, role: o.role, key: fromB64url(entry.key!) });
  await relay.grant(g.grant, g.sealed);
}

// Ends a member's grant, then rekeys: a new random key at the next epoch,
// and fresh grants to everyone left. What the removed member had, they keep.
export async function unshare(relay: Relay, root: Uint8Array, ownerId: string, index: Replica, rep: Replica, member: string) {
  const entry = entries(index).find((x) => x.object === rep.object);
  if (!entry) throw new Error(`${rep.object} isn't in the index`);
  await relay.ungrant(rep.object, member);
  await rekeyShared(relay, accountKeys(root), ownerId, index, rep, entry);
}

// A shared object onto a new random key, its grants sealed again for it.
async function rekeyShared(relay: Relay, owner: AccountKeys, ownerId: string, index: Replica, rep: Replica, entry: IndexEntry) {
  const key = random(32);
  await rep.rekey(key);
  const next: IndexEntry = { ...entry, epoch: rep.currentEpoch, key: b64url(key) };
  await remember(index, next);
  await index.push();
  const seen = new Set<string>();
  for (const { grant } of await relay.grants(rep.object)) {
    if (seen.has(grant.body.member)) continue;
    seen.add(grant.body.member);
    const g = grantTo(owner, ownerId, await relay.accountView(grant.body.member), { ...next, role: grant.body.role, key });
    await relay.grant(g.grant, g.sealed);
  }
}

// Rotation --------------------------------------------------------------------------
//
// Revoking a device stops it syncing, but its root still opens everything
// and still derives the account key. Rotation ends that: a new root, every
// object's state written again under it, the relay told the new key, and
// the new root sealed to each device kept.

// For a device whose cert stopped counting: the new root and cert, checked.
// known: the key it knew the account by.
export function checkRotated(r: Rotated, known: string, device: Device): { root: Uint8Array; cert: Signed<DeviceCert> } {
  let key = known;
  let moved = false;
  for (const rot of r.rotations) {
    if (rot.body.from !== key) continue;
    if (!isRotation(rot.body) || !verify(key, rotationBytes(rot.body), rot.sig)) throw new Error("a rotation isn't signed by the key before it");
    key = rot.body.to;
    moved = true;
  }
  if (!moved) throw new Error("no rotation from the key this device knows");
  const root = openSealed(device.box.secret, device.box.public, fromB64url(r.root));
  if (accountKeys(root).id !== key) throw new Error("the new root isn't the rotated account's");
  const bad = checkCert(key, r.cert);
  if (bad) throw new Error(bad);
  if (r.cert.body.device !== device.id || r.cert.body.box !== b64url(device.box.public)) throw new Error("the new certificate isn't this device's");
  return { root, cert: r.cert };
}

// A record's state as changes, to write it into another object.
export function changesOf(state: BoardState): CardChange[] {
  return cards(state).flatMap(({ id, log, ...fields }) => [
    ...(Object.keys(fields).length ? [{ t: "card" as const, card: id, set: fields }] : []),
    ...log.map((entry) => ({ t: "log" as const, card: id, entry })),
  ]);
}

// What a rotation needs from its caller: replicas by object (open, under
// the key and epoch given), and somewhere the new root is kept before
// anything else, so a crash can be resumed.
export type Rotating = {
  replica(root: Uint8Array, object: string, key: Uint8Array, epoch: number): Promise<Replica>;
  keepRoot(root: Uint8Array): Promise<void>;
};

// The rotating device's half. accountId: the account's first key, which
// never changes; keep: the devices to keep (their certs), this one among
// them. Returns the new root, whose phrase is the new recovery phrase, and
// this device's new cert, which relay now signs in with.
export async function rotate(
  relay: Relay,
  root: Uint8Array,
  accountId: string,
  device: Device,
  keep: DeviceCert[],
  r: Rotating,
): Promise<{ root: Uint8Array; cert: Signed<DeviceCert> }> {
  if (!keep.some((c) => c.device === device.id)) throw new Error("the rotating device must be one of those kept");
  const old = accountKeys(root);
  const fresh = newRoot();
  await r.keepRoot(fresh);
  const next = accountKeys(fresh);
  const oldIndex = await r.replica(root, indexId(root), indexKey(root), 0);
  await oldIndex.sync();
  const newIndex = await r.replica(fresh, indexId(fresh), indexKey(fresh), 0);
  const moved: { rep: Replica; e: IndexEntry }[] = [];
  const into = (e: IndexEntry) => r.replica(fresh, objectId(fresh, e.kind, e.name), objectKey(fresh, e.kind, e.name), 0);
  for (const e of entries(oldIndex)) {
    const rep = await r.replica(root, e.object, keyOf(root, e), e.epoch);
    await rep.sync();
    if (e.key) {
      // Shared: the same id, a new random key at the next epoch, its grants sealed again.
      await rekeyShared(relay, next, accountId, newIndex, rep, e);
      continue;
    }
    const to = await into(e);
    const changes = changesOf(rep.state);
    if (changes.length) await to.change(...changes);
    await to.push();
    await remember(newIndex, { object: to.object, kind: e.kind, name: e.name, epoch: 0 });
    moved.push({ rep, e });
  }
  await newIndex.push();
  const rotation = signRotation(old, { v: 1, account: accountId, from: old.id, to: next.id, box: b64url(next.box.public), at: Date.now() });
  const certs = keep.map((c) => certify(next, { id: c.device, box: fromB64url(c.box) }, c.name));
  const roots = Object.fromEntries(keep.map((c) => [c.device, b64url(sealTo(fromB64url(c.box), fresh))]));
  await relay.rotate(rotation, certs, roots);
  const cert = certs.find((c) => c.body.device === device.id)!;
  // Every token ended with the old key: the next call signs in with the new cert.
  relay.useCert(cert);
  // Anything written meanwhile goes across too (merging makes it harmless
  // twice), then the old logs go: they're still the account's, under its id.
  for (const { rep, e } of moved) {
    const before = rep.cursor;
    await rep.pull().catch(() => {});
    if (rep.cursor > before) {
      const to = await into(e);
      await to.change(...changesOf(rep.state));
      await to.push();
    }
    await relay.deleteLog(rep.object).catch(() => {});
  }
  await relay.deleteLog(oldIndex.object).catch(() => {});
  return { root: fresh, cert };
}
