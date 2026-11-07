// A spawn's way onto the forge (.agent/plans/forge-keys.md): fleetd makes
// it a key at the claim, the node signs that key a grant of what its
// template's git names (bridge/node/fleet.ts's gitGrant), and fleetd opens
// sessions at the gate with it. The key stays on the host: the guest gets
// only the session's token, in its share as git-token, which its git's
// credential helper hands over as the password (fleet/guest/slot.nix), and
// a new one before the hour is up. The grant lasts a day; one still running
// asks the node for another before then.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Chain, Signer } from "../../lib/e2ee/forge";
import { type ForgeSession, openForgeSession } from "../../lib/e2ee/forge-client";
import { b64url, fromB64url } from "../../lib/e2ee/wire";
import type { Manifest, Spawn } from "./fleet";

// What a spawn keeps of its grant: the node's answer, and its key's secret.
export type Git = { account: string; gate: string; chain: Chain; key: string };

// A new session this long before the last one ends.
const RENEW_MS = 10 * 60_000;
// And no sooner than this after one that failed.
const RETRY_MS = 60_000;
// A new grant this long before the last one ends.
const REGRANT_MS = 2 * 3600_000;

export function newHolder(): { id: string; key: string } {
  const secret = ed25519.utils.randomSecretKey();
  return { id: b64url(ed25519.getPublicKey(secret)), key: b64url(secret) };
}

export function signerOf(git: Git): Signer {
  const secret = fromB64url(git.key);
  const pub = ed25519.getPublicKey(secret);
  return { id: b64url(pub), sign: { secret, public: pub } };
}

// The chain's last holder, which must be this key's.
const holderOf = (git: Git) => git.chain.grants?.at(-1)?.body.holder;

export class GitSessions {
  private by = new Map<string, { expires: number; tried?: number; regrantTried?: number }>();

  // regrant asks the node for another grant to the same key; save keeps
  // the spawn with it.
  constructor(
    private open: (gate: string, account: string, holder: Signer, chain: Chain) => Promise<ForgeSession> = openForgeSession,
    private regrant?: (s: Spawn, holder: string) => Promise<Omit<Git, "key"> | undefined>,
    private save?: (s: Spawn) => void,
  ) {}

  // The token in the share, when there's none yet or it's nearly over; and
  // the grant, when it's nearly over.
  async keep(shareDir: string, s: Spawn, now = Date.now()) {
    let git = s.remote?.git;
    if (!git) return;
    const was = this.by.get(s.id) ?? { expires: 0 };
    this.by.set(s.id, was);
    const signer = signerOf(git);
    if (holderOf(git) !== signer.id) {
      if (!was.tried) console.error(`${s.id}: the forge: its grant is another key's`);
      was.tried = now;
      return;
    }
    const ends = git.chain.grants?.at(-1)?.body.expires ?? Infinity;
    if (this.regrant && ends - now < REGRANT_MS && !(was.regrantTried && now - was.regrantTried < RETRY_MS)) {
      try {
        const next = await this.regrant(s, signer.id);
        if (next?.chain.grants?.at(-1)?.body.holder !== signer.id) throw new Error("the node gave no new grant");
        git = s.remote!.git = { ...next, key: git.key };
        this.save?.(s);
        was.expires = 0; // a session on the new one
        delete was.regrantTried;
      } catch (e) {
        if (!was.regrantTried) console.error(`${s.id}: a new git grant: ${(e as Error).message}`);
        was.regrantTried = now;
      }
    }
    if (was.expires - now > RENEW_MS) return;
    if (was.tried && now - was.tried < RETRY_MS) return;
    try {
      const got = await this.open(git.gate, git.account, signer, git.chain);
      writeFileSync(join(shareDir, "git-token"), got.token + "\n", { mode: 0o600 });
      this.by.set(s.id, { expires: got.expires, ...(was.regrantTried && { regrantTried: was.regrantTried }) });
    } catch (e) {
      if (!was.tried) console.error(`${s.id}: the forge: ${(e as Error).message}`);
      was.tried = now;
    }
  }

  // Each running spawn's, and those over forgotten.
  async step(m: Manifest, all: Spawn[], now = Date.now()) {
    const running = new Set<string>();
    for (const s of all) {
      if (s.state !== "running" || !s.remote?.git || !s.slot || !m.slots[s.slot]) continue;
      running.add(s.id);
      await this.keep(m.slots[s.slot].shareDir, s, now);
    }
    for (const id of this.by.keys()) if (!running.has(id)) this.by.delete(id);
  }
}

// What the agent is told of it.
export function gitNote(s: Spawn): string {
  const g = s.remote?.git?.chain.grants?.at(-1)?.body;
  if (!g) return "";
  const host = new URL(s.remote!.git!.gate).host;
  const perms = g.perms ? g.perms.split(" ").join(", ") : "read only";
  return `\n\nYou have git access at https://${host}/ to ${g.repos.split(" ").join(", ")} (${perms}${g.refs ? `; pushes only to ${g.refs.split(" ").join(", ")}` : ""}); git's credentials for it are set up already.`;
}
