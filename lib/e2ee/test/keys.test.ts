import { describe, expect, it } from "bun:test";
import { accountKeys, derive, newRoot, objectId, objectKey } from "../keys";
import { Tampered, openBlob, openRecord, sealBlob, sealRecord } from "../record";
import { fromPhrase, toPhrase } from "../phrase";
import { certify, checkCert, creation, newDevice, revoke, verify } from "../device";
import { b64url, canonical, certBytes, creationBytes } from "../wire";

describe("keys", () => {
  it("derive the same keys from the same root, and different ones per label", () => {
    const root = newRoot();
    expect(accountKeys(root).id).toBe(accountKeys(root.slice()).id);
    expect(objectKey(root, "board", "a")).toEqual(objectKey(root, "board", "a"));
    expect(objectKey(root, "board", "a")).not.toEqual(objectKey(root, "board", "b"));
    expect(objectKey(root, "board", "a")).not.toEqual(objectKey(root, "brain", "a"));
    expect(objectId(root, "board", "a")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(objectId(root, "board", "a")).not.toBe(objectId(newRoot(), "board", "a"));
    expect(derive(root, "account sign")).not.toEqual(derive(root, "account box"));
    expect(() => derive(new Uint8Array(16), "x")).toThrow();
  });
});

describe("records", () => {
  const root = newRoot();
  const key = objectKey(root, "board", "home");
  const body = { title: "buy milk", n: 3 };

  it("round-trip", () => {
    const s = sealRecord(key, "obj", "op1", body);
    expect(s.nonce.length).toBe(24);
    expect(openRecord(key, "obj", "op1", s)).toEqual(body);
  });

  it("fail with the wrong key", () => {
    const s = sealRecord(key, "obj", "op1", body);
    expect(() => openRecord(objectKey(root, "board", "work"), "obj", "op1", s)).toThrow(Tampered);
  });

  it("fail when moved to another object or op", () => {
    const s = sealRecord(key, "obj", "op1", body);
    expect(() => openRecord(key, "obj2", "op1", s)).toThrow(Tampered);
    expect(() => openRecord(key, "obj", "op2", s)).toThrow(Tampered);
  });

  it("fail when any byte changes", () => {
    const s = sealRecord(key, "obj", "op1", body);
    for (let i = 0; i < s.ciphertext.length; i += 5) {
      const c = s.ciphertext.slice();
      c[i] ^= 0x80;
      expect(() => openRecord(key, "obj", "op1", { nonce: s.nonce, ciphertext: c })).toThrow(Tampered);
    }
    const n = s.nonce.slice();
    n[0] ^= 1;
    expect(() => openRecord(key, "obj", "op1", { nonce: n, ciphertext: s.ciphertext })).toThrow(Tampered);
    expect(() => openRecord(key, "obj", "op1", { nonce: s.nonce, ciphertext: s.ciphertext.subarray(0, 10) })).toThrow(Tampered);
  });

  it("blobs round-trip, bound to their id", () => {
    const k = crypto.getRandomValues(new Uint8Array(32));
    const bytes = crypto.getRandomValues(new Uint8Array(100_000));
    const b = sealBlob(k, "blob-aaaaaaaaaaaaaaaa", bytes);
    expect(openBlob(k, "blob-aaaaaaaaaaaaaaaa", b)).toEqual(bytes);
    expect(() => openBlob(k, "blob-bbbbbbbbbbbbbbbb", b)).toThrow(Tampered);
  });
});

describe("recovery phrase", () => {
  it("is 24 words that give the root back", () => {
    const root = newRoot();
    const phrase = toPhrase(root);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(fromPhrase(phrase)).toEqual(root);
    expect(fromPhrase(`  ${phrase.toUpperCase().replaceAll(" ", "\n ")} `)).toEqual(root);
  });

  it("refuses a wrong word or a short phrase", () => {
    const words = toPhrase(newRoot()).split(" ");
    words[3] = words[3] === "abandon" ? "ability" : "abandon";
    expect(() => fromPhrase(words.join(" "))).toThrow();
    expect(() => fromPhrase(toPhrase(newRoot()).split(" ").slice(0, 12).join(" "))).toThrow();
  });
});

describe("device certificates", () => {
  const account = accountKeys(newRoot());
  const device = newDevice();

  it("chain to the account", () => {
    const cert = certify(account, device, "laptop");
    expect(checkCert(account.id, cert)).toBeNull();
    expect(verify(account.id, certBytes(cert.body), cert.sig)).toBe(true);
  });

  it("aren't good for another account, or changed, or signed by anyone else", () => {
    const cert = certify(account, device, "laptop");
    const other = accountKeys(newRoot());
    expect(checkCert(other.id, cert)).toMatch(/another account/);
    expect(checkCert(account.id, { ...cert, body: { ...cert.body, name: "phone" } })).toMatch(/isn't signed/);
    // A device can't vouch for another: only the account key can.
    const forged = certify({ ...account, sign: device.sign }, newDevice(), "evil");
    expect(checkCert(account.id, forged)).toMatch(/isn't signed/);
    expect(checkCert(account.id, { body: { v: 1 }, sig: "x" } as never)).toMatch(/not a device/);
  });

  it("stop counting once revoked, by the account's signature only", () => {
    const cert = certify(account, device, "laptop");
    const r = revoke(account, device.id);
    expect(checkCert(account.id, cert, [r])).toMatch(/revoked/);
    // A revocation someone else signed doesn't.
    const fake = revoke({ ...accountKeys(newRoot()), id: account.id }, device.id);
    expect(checkCert(account.id, cert, [fake])).toBeNull();
    expect(checkCert(account.id, certify(account, newDevice(), "phone"), [r])).toBeNull();
  });

  it("sign the creation statement, bound to the relay and invite", () => {
    const c = creation(account, "https://relay.test", "inv");
    expect(verify(account.id, creationBytes(c.body), c.sig)).toBe(true);
    expect(verify(account.id, creationBytes({ ...c.body, invite: "other" }), c.sig)).toBe(false);
  });

  it("canonical JSON sorts keys and refuses what isn't flat", () => {
    expect(canonical({ b: 1, a: "x", c: null })).toBe('{"a":"x","b":1,"c":null}');
    expect(() => canonical({ a: 1.5 })).toThrow();
    expect(() => canonical({ a: {} as never })).toThrow();
    expect(b64url(new Uint8Array([255, 254]))).toBe("__4");
  });
});
