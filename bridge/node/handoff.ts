// Episodes handed to the node that leads (.agent/plans/local-memory.md,
// step 8b): a node that isn't the one the tunnel goes to, while that one
// is connected, doesn't consolidate what its sessions recorded but gives it
// over. The transcript goes up as a blob, gzipped and sealed with the
// brain's key, and an `episode:<id>` record in the brain's replica says
// where it is and how far its session was read already. The leader takes
// it from there: gets and opens the blob, keeps the episode as if its own
// hooks had sent it, then clears the record and deletes the blob.
//
// Taken twice (the leader changed in between), it's consolidated twice, and
// the log keeps each bullet once by its key, so nothing shows twice.

import { openBlob, sealBlob } from "../../lib/e2ee/record";
import { random } from "../../lib/e2ee/keys";
import { LIMITS, b64url, fromUtf8, utf8 } from "../../lib/e2ee/wire";
import type { Episode, Episodes } from "./episodes";
import { EPISODE_PREFIX, episodeRecord } from "./objects";
import type { Replicas } from "./replicas";

// What the relay keeps blobs in (lib/e2ee/relay.ts's Relay).
export type Blobs = {
  putBlob(id: string, bytes: Uint8Array): Promise<void>;
  getBlob(id: string): Promise<Uint8Array>;
  deleteBlob(id: string): Promise<void>;
};

type Handed = { blob: string; epoch: number; session: string; agent: string; trigger: string; through: string | null };

export class Handoff {
  constructor(private o: { replicas: Replicas; episodes: Episodes; blobs: Blobs }) {}

  private replica(brain: string) {
    const rep = this.o.replicas.get("brain", brain);
    if (!rep) throw new Error(`no brain ${brain} on this node`);
    return rep;
  }

  // An episode given over: through, how far this node read its session.
  async give(brain: string, e: Episode, transcript: string, through?: string) {
    const rep = this.replica(brain);
    const epoch = rep.currentEpoch;
    const key = await rep.key(epoch);
    if (!key) throw new Error(`no key for brain ${brain}`);
    const blob = b64url(random(18));
    const sealed = sealBlob(key, blob, Bun.gzipSync(utf8(transcript)));
    if (sealed.length > LIMITS.blob) throw new Error(`episode ${e.id} is too big to hand over`);
    await this.o.blobs.putBlob(blob, sealed);
    const handed: Handed = { blob, epoch, session: e.session, agent: e.agent, trigger: e.trigger, through: through ?? null };
    await this.o.replicas.change("brain", brain, { t: "card", card: episodeRecord(e.id), set: handed });
  }

  // The episodes handed to this node, kept here; how many. One that can't be
  // had yet stays for the next time, one whose blob is gone is let go of.
  async take(brain: string): Promise<number> {
    const rep = this.replica(brain);
    let took = 0;
    for (const c of rep.cards()) {
      if (!c.id.startsWith(EPISODE_PREFIX) || typeof c.blob !== "string") continue;
      const h = c as unknown as Handed & { id: string };
      try {
        const key = await rep.key(h.epoch);
        if (!key) throw new Error(`no key for epoch ${h.epoch}`);
        const bytes = await this.o.blobs.getBlob(h.blob).catch((e: { status?: number }) => (e.status === 404 ? null : Promise.reject(e)));
        if (bytes) {
          const transcript = fromUtf8(Bun.gunzipSync(openBlob(key, h.blob, bytes) as Uint8Array<ArrayBuffer>));
          if (h.through) this.o.episodes.restoreThrough(brain, h.session, h.through);
          this.o.episodes.add(brain, { session: h.session, agent: h.agent, trigger: h.trigger, transcript });
          took++;
        } else console.error(`handoff: ${brain}: episode ${c.id.slice(EPISODE_PREFIX.length)} is gone from the relay`);
        await this.o.replicas.change("brain", brain, {
          t: "card",
          card: c.id,
          set: { blob: null, epoch: null, session: null, agent: null, trigger: null, through: null },
        });
        if (bytes) await this.o.blobs.deleteBlob(h.blob).catch((e) => console.error(`handoff: ${brain}: deleting blob: ${(e as Error).message}`));
      } catch (e) {
        console.error(`handoff: ${brain}: episode ${c.id.slice(EPISODE_PREFIX.length)}: ${(e as Error).message}`);
      }
    }
    return took;
  }
}
