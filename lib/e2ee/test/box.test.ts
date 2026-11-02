import { describe, expect, it } from "bun:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { openSealed, sealTo } from "../box";
import { boxPair, random } from "../keys";
import { Tampered } from "../record";
import { fromUtf8, utf8 } from "../wire";

// Made by libsodium-wrappers-sumo 0.7.15's crypto_box_seal, so ours opens
// what libsodium (and so the Android app) seals.
const LIBSODIUM = {
  pk: "020380a533840954745c5d850e98456db8192edbd866d2df3b0aef5e083c5a19",
  sk: "9ba6694f505f9da3e742caa7857f33164fd0f4e97ba1bc4a20f9858cc2702b09",
  c: "30380907de9146600cd038a806e5cdb84e6e62521c3b8730cc5f003368f59d0aa5c0c708c8589412616796a408a2b893307abda135021afea2a9d9794c573ea6b9c863ce762449bb7c26fd",
};

describe("sealed boxes", () => {
  it("open what libsodium sealed", () => {
    const m = openSealed(hexToBytes(LIBSODIUM.sk), hexToBytes(LIBSODIUM.pk), hexToBytes(LIBSODIUM.c));
    expect(fromUtf8(m)).toBe("corkboard sealed box vector");
  });

  it("round-trip, and only for the recipient", () => {
    const me = boxPair(random(32));
    const you = boxPair(random(32));
    const key = random(32);
    const sealed = sealTo(me.public, key);
    expect(sealed.length).toBe(32 + 32 + 16);
    expect(openSealed(me.secret, me.public, sealed)).toEqual(key);
    expect(() => openSealed(you.secret, you.public, sealed)).toThrow(Tampered);
  });

  it("refuse a changed byte anywhere", () => {
    const me = boxPair(random(32));
    const sealed = sealTo(me.public, utf8("a board key"));
    for (const i of [0, 31, 32, 47, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] ^= 1;
      expect(() => openSealed(me.secret, me.public, bad)).toThrow(Tampered);
    }
  });
});
