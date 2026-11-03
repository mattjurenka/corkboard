// A pairing mailbox (MAILBOX, named by its code): the few messages a new
// device and an approving one swap for the root to pass between them
// (lib/e2ee/pairing.ts has the protocol, and why it's safe with this relay
// in the middle). It holds only public keys, a commitment, and the root
// encrypted to the new device. Each step happens once and in order; the
// mailbox goes when its root has been read, when either side cancels, or
// ten minutes after it was made.
//
// The new device is whoever holds the secret the mailbox was made with;
// the approver is the first signed-in account to commit, and only it sees
// the new device's keys.

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./result";
import { KEY } from "../../lib/e2ee/wire";

export const PAIR_TTL = 10 * 60_000;

type Box = {
  secret: string;
  expires: number;
  // The approving account.
  account?: string;
  commit?: string;
  join?: { box: string; device: string; name: string };
  reveal?: string;
  deliver?: { nonce: string; ciphertext: string };
};

export type View = { code: string; expires: number; commit?: string; join?: Box["join"]; reveal?: string; deliver?: Box["deliver"] };

const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });
const done: Result<true> = { ok: true, value: true };

export class Mailbox extends DurableObject {
  private async box(): Promise<Box | undefined> {
    const b = await this.ctx.storage.get<Box>("box");
    if (b && b.expires < Date.now()) {
      await this.ctx.storage.deleteAll();
      return;
    }
    return b;
  }

  private save(b: Box) {
    return this.ctx.storage.put("box", b);
  }

  // false: the code is taken (made again with another).
  async init(secret: string): Promise<number | false> {
    if (await this.box()) return false;
    const expires = Date.now() + PAIR_TTL;
    await this.save({ secret, expires });
    await this.ctx.storage.setAlarm(expires);
    return expires;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  // The new device's view, everything; once it has seen the delivery, the mailbox is gone.
  async viewNew(code: string, secret: string): Promise<Result<View>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.secret !== secret) return fail(403, "not this pairing's device");
    const { commit, join, reveal, deliver } = b;
    if (deliver) await this.ctx.storage.deleteAll();
    return { ok: true, value: { code, expires: b.expires, commit, join, reveal, deliver } };
  }

  // The approver's view: the new device's keys only once it has committed.
  async viewApprover(code: string, account: string): Promise<Result<View>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.account && b.account !== account) return fail(403, "another account is approving this pairing");
    return { ok: true, value: { code, expires: b.expires, commit: b.commit, ...(b.account && { join: b.join, reveal: b.reveal }) } };
  }

  async commit(account: string, commit: string): Promise<Result<true>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.commit) return fail(409, "another device is already approving this pairing");
    if (!KEY.test(commit)) return fail(400, "commit must be a 32-byte hash");
    await this.save({ ...b, account, commit });
    return done;
  }

  async join(secret: string, j: { box: string; device: string; name: string }): Promise<Result<true>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.secret !== secret) return fail(403, "not this pairing's device");
    if (!b.commit) return fail(409, "no device is approving yet");
    if (b.join) return fail(409, "already joined");
    if (!KEY.test(j.box) || !KEY.test(j.device) || typeof j.name !== "string" || j.name.length > 100) return fail(400, "join needs box and device keys and a name");
    await this.save({ ...b, join: { box: j.box, device: j.device, name: j.name } });
    return done;
  }

  async reveal(account: string, approver: string): Promise<Result<true>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.account !== account) return fail(403, "another account is approving this pairing");
    if (!b.join) return fail(409, "the new device hasn't joined yet");
    if (b.reveal) return fail(409, "already revealed");
    if (!KEY.test(approver)) return fail(400, "approver must be a key");
    await this.save({ ...b, reveal: approver });
    return done;
  }

  async deliver(account: string, d: { nonce: string; ciphertext: string }): Promise<Result<true>> {
    const b = await this.box();
    if (!b) return fail(404, "no such pairing (or it has ended)");
    if (b.account !== account) return fail(403, "another account is approving this pairing");
    if (!b.reveal) return fail(409, "not revealed yet");
    if (b.deliver) return fail(409, "already delivered");
    if (typeof d.nonce !== "string" || typeof d.ciphertext !== "string" || d.nonce.length > 64 || d.ciphertext.length > 8192) return fail(400, "deliver needs a nonce and a ciphertext");
    await this.save({ ...b, deliver: { nonce: d.nonce, ciphertext: d.ciphertext } });
    return done;
  }

  // Either side's: the new device by its secret, the approver by its account.
  async cancel(who: { secret: string } | { account: string }): Promise<Result<true>> {
    const b = await this.box();
    if (!b) return done;
    if ("secret" in who ? who.secret !== b.secret : who.account !== b.account) return fail(403, "not this pairing's");
    await this.ctx.storage.deleteAll();
    return done;
  }
}
