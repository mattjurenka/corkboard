import { describe, expect, it } from "bun:test";
import { checkCert, newDevice } from "../device";
import { accountKeys, newRoot } from "../keys";
import { type MailboxView, type PairTransport, approve, pairNew, parseQr } from "../pairing";
import { CODE_ALPHABET, b64url } from "../wire";

// A mailbox as the relay keeps one (relay/src/mailbox.ts), in memory, with
// its order enforced; code: to make two that share one, for a relay in the middle.
function mailbox(code = Array.from({ length: 10 }, () => CODE_ALPHABET[Math.floor(Math.random() * 32)]).join("")): PairTransport & { box: MailboxView } {
  const secret = "s3cret";
  const box: MailboxView = { code, expires: Date.now() + 60_000 };
  const once = (k: keyof MailboxView, v: never) => {
    if (box[k] !== undefined) throw new Error(`${k} already`);
    (box as Record<string, unknown>)[k] = v;
  };
  return {
    box,
    create: async () => ({ code, secret, expires: box.expires }),
    view: async (_c, s) => (s && s !== secret ? Promise.reject(new Error("wrong secret")) : structuredClone(box)),
    commit: async (_c, commit) => once("commit", commit as never),
    join: async (_c, s, j) => {
      if (s !== secret || !box.commit) throw new Error("not yet");
      once("join", j as never);
    },
    reveal: async (_c, a) => {
      if (!box.join) throw new Error("not yet");
      once("reveal", a as never);
    },
    deliver: async (_c, d) => {
      if (!box.reveal) throw new Error("not yet");
      once("deliver", d as never);
    },
    cancel: async () => void (box.expires = 0),
  };
}

const fast = { interval: 1, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

// The person, looking at both screens: says yes on each only if the two
// six-digit codes are the same.
function person() {
  let a!: (s: string) => void, b!: (s: string) => void;
  const onNew = new Promise<string>((r) => (a = r));
  const onOld = new Promise<string>((r) => (b = r));
  return {
    newSide: async (s: string) => (a(s), s === (await onOld)),
    oldSide: async (s: string) => (b(s), s === (await onNew)),
  };
}

describe("pairing", () => {
  it("gives the new device the root and a cert for itself", async () => {
    const root = newRoot();
    const relay = mailbox();
    const dev = newDevice();
    const p = person();
    let code = "";
    let qr = "";
    const [got, cert] = await Promise.all([
      pairNew(relay, dev, "phone", { show: (c, q) => ((code = c), (qr = q)), confirm: p.newSide }, fast),
      (async () => {
        while (!code) await new Promise((r) => setTimeout(r, 1));
        return approve(relay, root, code, { confirm: p.oldSide }, fast);
      })(),
    ]);
    expect(got.root).toEqual(root);
    expect(got.cert).toEqual(cert);
    expect(checkCert(accountKeys(root).id, got.cert)).toBeNull();
    expect(got.cert.body.device).toBe(dev.id);
    expect(parseQr(qr)?.code).toBe(code);
  });

  it("checks a scanned QR's key against the device that joined", async () => {
    const relay = mailbox();
    const dev = newDevice();
    const stranger = newDevice();
    const p = person();
    let qr = "";
    const n = pairNew(relay, dev, "phone", { show: (_c, q) => (qr = q), confirm: p.newSide }, { ...fast, until: Date.now() + 300 });
    while (!qr) await new Promise((r) => setTimeout(r, 1));
    const { code } = parseQr(qr)!;
    // As if the QR scanned were the stranger's.
    await expect(approve(relay, newRoot(), code, { confirm: async () => true }, { ...fast, box: b64url(stranger.box.public) })).rejects.toThrow(/scanned/);
    await expect(n).rejects.toThrow();
  });

  it("can't be joined by a relay in the middle: the codes differ, and both refuse", async () => {
    // The relay runs two mailboxes under one code: towards the new device it
    // approves with a root of its own; towards the old one it's a new device.
    const code = "ABCDE12345";
    const toNew = mailbox(code);
    const toOld = mailbox(code);
    const mitm = newDevice();
    const theirs = newRoot();
    const root = newRoot();
    const p = person();
    let delivered = false;
    const n = pairNew(toNew, newDevice(), "phone", { show: () => {}, confirm: p.newSide }, fast);
    const o = approve(toOld, root, code, { confirm: p.oldSide }, fast);
    const m1 = approve(toNew, theirs, code, { confirm: async () => true }, fast).catch(() => {});
    const m2 = pairNew(toOld, mitm, "evil", { show: () => {}, confirm: async () => true }, { ...fast, until: Date.now() + 500 })
      .then(() => (delivered = true))
      .catch(() => {});
    const [rn, ro] = await Promise.allSettled([n, o]);
    expect(rn).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/didn't match/) }) });
    expect(ro).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/didn't match/) }) });
    await Promise.all([m1, m2]);
    expect(delivered).toBe(false);
    expect(toOld.box.deliver).toBeUndefined();
  });

  it("refuses an approver whose key isn't what it committed to", async () => {
    const relay = mailbox();
    const real = relay.reveal;
    relay.reveal = (c, _a) => real(c, "A".repeat(43));
    let code = "";
    const n = pairNew(relay, newDevice(), "phone", { show: (c) => (code = c), confirm: async () => true }, fast);
    while (!code) await new Promise((r) => setTimeout(r, 1));
    const o = approve(relay, newRoot(), code, { confirm: async () => true }, { ...fast, until: Date.now() + 300 });
    await expect(n).rejects.toThrow(/committed/);
    // The approver can't tell, but what it delivered opens only for the real device.
    await o.catch(() => {});
  });
});
