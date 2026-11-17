import { describe, expect } from "bun:test";
import { openSealed, sealTo } from "../box";
import { boxPair } from "../keys";
import { type Op, apply, cards, empty, join, stateOf } from "../merge";
import { Tampered, open, openBlob, openRecord } from "../record";
import { CODE_ALPHABET, b64url, canonical, fromB64url, isCert, isGrant, isRevocation, isRotation, normalizeCode, showCode } from "../wire";
import { type Gen, fuzz } from "../../testing/fuzz";

// What comes off the wire or out of a decrypted op is the other side's to
// choose: whatever it is, these take it or refuse it, and never throw
// anything else.

const CARD_KEYS = ["v", "clock", "device", "change", "t", "card", "set", "entry", "at", "who", "note", "title", "status", "log", "id"];

// An op, mostly well-formed and now and then not, with the keys a merge
// reads and the ones an object has already.
function op(g: Gen): Op {
  if (g.bool(0.1)) return g.json(4, CARD_KEYS) as Op;
  const card = g.bool(0.7) ? g.pick(["c1", "c2", "c3"]) : g.key(["c1"]);
  const set: Record<string, unknown> = {};
  for (let n = g.size(4); n > 0; n--) Object.defineProperty(set, g.key(["title", "status", "body"]), { value: g.json(1), enumerable: true, writable: true, configurable: true });
  return {
    v: 1,
    clock: g.bool(0.9) ? g.int(0, 20) : (g.json(0) as number),
    device: g.pick(["a", "b", "c"]),
    change: g.bool(0.7) ? { t: "card", card, set } : { t: "log", card, entry: { at: g.string(4), who: g.string(4), note: g.string(8) } },
  };
}

describe("parsing, fuzzed", () => {
  fuzz(
    "merge takes or skips any op without throwing, and every order of them comes out the same",
    (g) => {
      // An op's id is its own (the relay keeps one op by each), whatever it is.
      const ids = new Set<string>();
      const ops = Array.from({ length: g.int(1, 30) }, (_, k) => {
        const id = g.bool(0.2) ? g.key() : `op${k}`;
        return [ids.has(id) ? `op${k}` : (ids.add(id), id), op(g)] as const;
      });
      const merged = (order: (readonly [string, Op])[]) => {
        const s = empty();
        for (const [id, o] of order) apply(s, id, o);
        // And as a store keeps it: JSON, and back.
        return JSON.stringify(cards(stateOf(JSON.parse(JSON.stringify(s)))));
      };
      const want = merged(ops);
      expect(merged(g.shuffle([...ops, ...ops.filter(() => g.bool(0.3))]))).toBe(want);
      expect(Object.prototype).not.toHaveProperty("fields");
    },
    { runs: 2000 },
  );

  fuzz(
    "joining two states is applying both their ops, and a state of any shape doesn't throw",
    (g) => {
      const ops = Array.from({ length: g.int(1, 30) }, (_, k) => [`op${k}`, op(g)] as const);
      const state = (xs: readonly (readonly [string, Op])[]) => {
        const s = empty();
        for (const [id, o] of xs) apply(s, id, o);
        return stateOf(JSON.parse(JSON.stringify(s)));
      };
      const [x, y] = [ops.filter(() => g.bool()), ops.filter(() => g.bool())];
      const joined = state(x);
      join(joined, state(y));
      expect(JSON.stringify(cards(joined))).toBe(JSON.stringify(cards(state([...x, ...y]))));

      const odd = { clock: g.int(0, 9), cards: g.json(4, ["c1", "fields", "log", "stamp", "value", "clock", "device", "op", "entry", "note", "__proto__", "constructor"]) as never };
      const s = state(x);
      if (odd.cards && typeof odd.cards === "object") join(s, odd);
      cards(s);
      expect(Object.prototype).not.toHaveProperty("fields");
    },
    { runs: 2000 },
  );

  fuzz(
    "a state as a store loads it gives no card a prototype",
    (g) => {
      const fields: Record<string, unknown> = {};
      for (let n = g.size(6); n > 0; n--) Object.defineProperty(fields, g.key(["title", "status"]), { value: { value: g.json(2, ["title", "status"]), stamp: { clock: 1, device: "a", op: "x" } }, enumerable: true, writable: true, configurable: true });
      // Through text, as a store keeps it: "__proto__" comes back an own key.
      const state = stateOf(JSON.parse(JSON.stringify({ clock: 1, cards: { c1: { fields, log: {} } } })));
      for (const c of cards(state)) expect(Object.getPrototypeOf(c)).toBeNull();
    },
    { runs: 2000 },
  );

  fuzz(
    "validators answer true or false for any JSON",
    (g) => {
      const v = g.json(3, ["v", "account", "device", "box", "name", "issued", "role", "owner", "object", "member", "epoch", "wrapped", "at", "from", "to"]);
      for (const f of [isCert, isRevocation, isGrant, isRotation]) expect(typeof f(v)).toBe("boolean");
    },
    { runs: 2000 },
  );

  fuzz(
    "base64url, canonical JSON and pairing codes round-trip",
    (g) => {
      const b = g.bytes(300);
      expect(fromB64url(b64url(b))).toEqual(b);
      const s = g.string(20);
      let decoded: Uint8Array | undefined;
      try {
        decoded = fromB64url(s);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
      if (decoded) expect(fromB64url(b64url(decoded))).toEqual(decoded);

      const o: Record<string, string | number | null> = {};
      for (let n = g.size(6); n > 0; n--) o[g.string(6)] = g.pick([g.string(6), g.int(-99, 99), null]);
      const back: typeof o = {};
      for (const k of g.shuffle(Object.keys(o))) back[k] = o[k];
      expect(canonical(back)).toBe(canonical(o));
      expect(JSON.parse(canonical(o))).toEqual(o);

      const code = Array.from({ length: 10 }, () => g.pick([...CODE_ALPHABET])).join("");
      expect(normalizeCode(showCode(code))).toBe(code);
      expect(normalizeCode(showCode(code).toLowerCase())).toBe(code);
      const typed = normalizeCode(g.string(14));
      if (typed !== undefined) expect(normalizeCode(typed)).toBe(typed);
    },
    { runs: 2000 },
  );

  const key = new Uint8Array(32).fill(7);
  const pair = boxPair(new Uint8Array(32).fill(9));
  fuzz(
    "anything that isn't sealed under the key is Tampered, and nothing else",
    (g) => {
      const tampered = (f: () => unknown) => expect(f).toThrow(Tampered);
      tampered(() => open(key, { nonce: g.bytes(30), ciphertext: g.bytes(80) }, g.bytes(8)));
      tampered(() => openRecord(key, "obj", "op", { nonce: g.bytes(30), ciphertext: g.bytes(80) }));
      tampered(() => openBlob(key, "blob", g.bytes(120)));
      tampered(() => openSealed(pair.secret, pair.public, g.bytes(120)));
      // And a real one, changed.
      const sealed = sealTo(pair.public, g.bytes(40));
      const changed = g.mutate(sealed);
      if (!Buffer.from(changed).equals(Buffer.from(sealed))) tampered(() => openSealed(pair.secret, pair.public, changed));
    },
    { runs: 1000 },
  );
});
