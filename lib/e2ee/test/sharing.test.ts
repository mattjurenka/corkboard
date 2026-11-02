import { describe, expect, it } from "bun:test";
import { sealTo } from "../box";
import { certify, creation, newDevice, signRotation } from "../device";
import { type BoardState, apply, cards, empty } from "../merge";
import { accountKeys, newRoot, random } from "../keys";
import { changesOf, checkRotated, currentKey, entries, grantTo, indexId, indexKey, openGrant, remember } from "../sharing";
import { type LogTransport, Replica } from "../sync";
import { type AccountView, type Rotation, type Signed, type WireOp, b64url } from "../wire";

// The parts of sharing.ts that need no relay; the rest runs against the
// Worker in cloud/test/e2ee.test.ts.

const ORIGIN = "https://relay.test";

// An account as the relay would show it, with any rotations since.
function view(root: Uint8Array, rotations: Signed<Rotation>[] = [], now = root): AccountView {
  const first = accountKeys(root);
  const keys = accountKeys(now);
  return { id: first.id, key: keys.id, box: b64url(keys.box.public), proof: { creation: creation(first, ORIGIN, null), rotations } };
}

function rotation(from: Uint8Array, to: Uint8Array, id = accountKeys(from).id) {
  const a = accountKeys(from);
  const b = accountKeys(to);
  return signRotation(a, { v: 1, account: id, from: a.id, to: b.id, box: b64url(b.box.public), at: Date.now() });
}

describe("accounts' keys", () => {
  it("chain from the id through each rotation", () => {
    const [r0, r1, r2] = [newRoot(), newRoot(), newRoot()];
    const id = accountKeys(r0).id;
    expect(currentKey(view(r0), id)).toBe(id);
    const v = view(r0, [rotation(r0, r1), rotation(r1, r2, id)], r2);
    expect(currentKey(v, id)).toBe(accountKeys(r2).id);
    // A rotation out of order, or a key the proof doesn't reach, doesn't count.
    expect(currentKey({ ...v, proof: { ...v.proof, rotations: v.proof.rotations.slice().reverse() } }, id)).toBeUndefined();
    expect(currentKey({ ...v, key: accountKeys(r1).id }, id)).toBeUndefined();
    expect(currentKey(v, accountKeys(r1).id)).toBeUndefined();
  });
});

describe("grants", () => {
  const owner = newRoot();
  const member = newRoot();
  const ownerId = accountKeys(owner).id;
  const memberId = accountKeys(member).id;
  const key = random(32);
  const o = { object: "b".repeat(22), kind: "brain" as const, name: "pepper", role: "read" as const, epoch: 1, key };

  it("carry the object's key to the member alone", () => {
    const g = grantTo(accountKeys(owner), ownerId, view(member), o);
    const got = openGrant(accountKeys(member), memberId, g, view(owner));
    expect(got).toEqual({ owner: ownerId, object: o.object, kind: "brain", name: "pepper", role: "read", epoch: 1, key });
    expect(() => openGrant(accountKeys(owner), ownerId, g, view(owner))).toThrow(/isn't to this account/);
  });

  it("refuse a sealed key swapped for another, or a grant someone else signed", () => {
    const g = grantTo(accountKeys(owner), ownerId, view(member), o);
    const swapped = { ...g, sealed: b64url(sealTo(accountKeys(member).box.public, random(64))) };
    expect(() => openGrant(accountKeys(member), memberId, swapped, view(owner))).toThrow(/isn't the one its owner signed for/);
    const forged = grantTo(accountKeys(newRoot()), ownerId, view(member), o);
    expect(() => openGrant(accountKeys(member), memberId, forged, view(owner))).toThrow(/isn't signed by its owner/);
  });

  it("follow the owner's key after it rotates", () => {
    const next = newRoot();
    const g = grantTo(accountKeys(next), ownerId, view(member), o);
    expect(() => openGrant(accountKeys(member), memberId, g, view(owner))).toThrow(/isn't signed/);
    expect(openGrant(accountKeys(member), memberId, g, view(owner, [rotation(owner, next)], next)).key).toEqual(key);
  });
});

describe("rotation", () => {
  it("hands a kept device the new root and cert, checked", () => {
    const [r0, r1] = [newRoot(), newRoot()];
    const device = newDevice();
    const cert = certify(accountKeys(r1), device, "phone");
    const rotated = { rotations: [rotation(r0, r1)], cert, root: b64url(sealTo(device.box.public, r1)) };
    expect(checkRotated(rotated, accountKeys(r0).id, device).root).toEqual(r1);
    // Another root, or a cert for another device, is refused.
    expect(() => checkRotated({ ...rotated, root: b64url(sealTo(device.box.public, newRoot())) }, accountKeys(r0).id, device)).toThrow(/isn't the rotated account's/);
    expect(() => checkRotated({ ...rotated, cert: certify(accountKeys(r1), newDevice(), "x") }, accountKeys(r0).id, device)).toThrow(/isn't this device's/);
    expect(() => checkRotated(rotated, accountKeys(r1).id, device)).toThrow(/no rotation/);
  });

  it("writes a record's state into another object as it was", () => {
    const s: BoardState = empty();
    apply(s, "o1", { v: 1, clock: 1, device: "d", change: { t: "card", card: "note:a", set: { title: "A", body: "x" } } });
    apply(s, "o2", { v: 1, clock: 2, device: "d", change: { t: "log", card: "note:a", entry: { at: "t", who: "w", note: "n" } } });
    apply(s, "o3", { v: 1, clock: 3, device: "d", change: { t: "card", card: "brain", set: { voice: "v" } } });
    const t = empty();
    changesOf(s).forEach((change, i) => apply(t, `n${i}`, { v: 1, clock: i + 1, device: "e", change }));
    expect(cards(t)).toEqual(cards(s));
  });
});

describe("the index", () => {
  it("keeps one entry per object, written only when it changes", async () => {
    const log: WireOp[] = [];
    const transport: LogTransport = {
      append: async (_, ops) => ops.map((o) => (log.push({ ...o, device: "d", pos: log.length + 1, ts: "" }), { id: o.id, pos: log.length })),
      read: async (_, since) => ({ ops: log.filter((w) => w.pos > since), head: log.length }),
    };
    const root = newRoot();
    const index = await Replica.open({ transport, key: indexKey(root), object: indexId(root), device: "d" });
    const e = { object: "o".repeat(22), kind: "board" as const, name: "home", epoch: 0 };
    await remember(index, e);
    await remember(index, e);
    await remember(index, { ...e, epoch: 1, key: "k".repeat(43) });
    await index.push();
    expect(log.length).toBe(2);
    expect(entries(index)).toEqual([{ ...e, epoch: 1, key: "k".repeat(43) }]);
  });
});
