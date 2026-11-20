// Which of the account's nodes leads (serve.ts): rollups, leases, the
// calendar and the forge run there, and the others hand it their episodes.
// It's the node the tunnel goes to: the leader the account names if it's
// connected, else the newest; this one, offline or with no tunnel. The
// relay is asked at most once a minute, and says itself when it changes
// (the tunnel's onLeader, told()).

import type { NodesView } from "../../lib/e2ee/wire";

export class Leadership {
  private led?: { at: number; to: string };
  // Whether the account has Forgejo's pages through the tunnel, as last looked.
  forgeWeb = false;

  // nodes: the relay's NodesView, while there's a relay and a tunnel.
  constructor(private o: { me: string; nodes: () => (() => Promise<NodesView>) | undefined; now?: () => number }) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  async leader(): Promise<string> {
    const look = this.o.nodes();
    if (!look) return this.o.me;
    if (this.led && this.now() - this.led.at < 60_000) return this.led.to;
    const v = await look();
    this.forgeWeb = !!v.forge;
    const nodes = v.connected.filter((c) => c.tunnel !== false);
    const to = nodes.find((c) => c.device === v.leader) ?? nodes.sort((a, b) => b.since - a.since)[0];
    this.led = { at: this.now(), to: to?.device ?? this.o.me };
    return this.led.to;
  }

  leads = async () => (await this.leader()) === this.o.me;

  // The relay's word on where the tunnel goes now: null, nowhere but here.
  told(to: string | null) {
    this.led = { at: this.now(), to: to ?? this.o.me };
  }
}

// Forgejo, run where the account names its leader, so a blip in its socket
// (the tunnel going to another node meanwhile) doesn't stop it; with none
// named, on the node that leads. Stopping it, its state goes to the relay
// at once; starting it, it's restored from there first. A failed look
// changes nothing.
export type ForgeProcess = { running: boolean; start(): Promise<void>; stop(): Promise<void>; admins(): Promise<string[]> };
export type ForgeState = { restore(): Promise<number>; step(now?: number, force?: boolean): Promise<unknown> };

export function forgeKeeper(o: {
  forge?: ForgeProcess;
  me: string;
  // The leader the account names, if there's a relay and a tunnel to ask.
  named: () => Promise<string | null>;
  leads: () => Promise<boolean>;
  snapshots?: ForgeState;
  records: { user(): string | undefined | null; setUser(u: string): Promise<unknown> };
  log?: (line: string) => void;
}) {
  const log = o.log ?? ((line: string) => console.error(line));
  return async () => {
    const forge = o.forge;
    if (!forge) return;
    try {
      const named = await o.named();
      if (!(named ? named === o.me : await o.leads())) {
        if (!forge.running) return await forge.stop();
        await forge.stop();
        return void (await o.snapshots?.step(Date.now(), true));
      }
      if (!forge.running) {
        const restored = await o.snapshots?.restore();
        if (restored) console.log(`node: the forge: ${restored} restored from the relay`);
      }
      await forge.start();
      await o.snapshots?.step();
      // A forge moved in with no login recorded is its one admin's.
      if (!o.records.user()) {
        const admins = await forge.admins();
        if (admins.length === 1) await o.records.setUser(admins[0]);
      }
    } catch (e) {
      log(`node: the forge: ${(e as Error).message}`);
    }
  };
}
