// The account's sessions as its hubs have them (hub.ts), watched from this
// machine (ciphertext-relay.md step 3): the node's own hub, and each
// connected device's on a sealed channel the node opens to it, so the relay
// carries them as ciphertext. The fleet view (cloud-session.ts) and away
// mode (remote.ts's peers) read them here beside the Worker's, and ask a
// bridge's session at the Worker's own paths, on its device's channel.
//
// A device's bridges stay as they were while its channel is down and come
// back whole when it's up again; they go when the device does.

import { type HubBridge, lines } from "./hub";

// The node's way to every hub of the account's (serve.ts's): this device
// and the ones connected, and a request to one's /api/sessions.
export type Reach = {
  devices(): Promise<{ me: string; devices: string[] }>;
  fetch(device: string, path: string, init?: RequestInit): Promise<Response>;
};

export type PeerBridge = HubBridge & { device: string };
// What changed: a bridge, or that one's gone.
export type PeerEvent = PeerBridge | { id: string; gone: true };
export type Attached = { send(m: object): void; close(): void };

// How often the list of devices is asked again.
const LOOK = 30_000;

export class Peers {
  private bridges = new Map<string, PeerBridge>();
  private followed = new Map<string, AbortController>();
  private fns = new Set<(b: PeerEvent) => void>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private reach: Reach) {}

  // Every bridge, but self (this bridge's id).
  list(self?: string): PeerBridge[] {
    return [...this.bridges.values()].filter((b) => b.id !== self);
  }

  has(bridge: string) {
    return this.bridges.has(bridge);
  }

  // Each change, from now; gives back the way to stop. Devices are looked
  // for while anyone listens.
  on(fn: (b: PeerEvent) => void): () => void {
    this.fns.add(fn);
    this.start();
    return () => void this.fns.delete(fn);
  }

  // Looked for now (once is enough for list()), and every LOOK after.
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.look(), LOOK);
    void this.look();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const a of this.followed.values()) a.abort();
    this.followed.clear();
  }

  // A request to a bridge's session, on its device's channel: path is the
  // Worker's (/api/sessions/:b/:k/...).
  fetch(bridge: string, path: string, init?: RequestInit): Promise<Response> {
    const b = this.bridges.get(bridge);
    if (!b) return Promise.resolve(Response.json({ error: `bridge ${bridge} isn't connected` }, { status: 404 }));
    return this.reach.fetch(b.device, path, init);
  }

  // A session's stream (its conversation, or terminal), on its device's
  // channel: each message as it comes, then ended, once, when it's over or
  // closed; send is a message for it (in, size).
  attach(bridge: string, key: string, terminal: boolean, message: (m: any) => void, ended: () => void): Attached {
    const enc = new TextEncoder();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
    const a = new AbortController();
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      try {
        push.close();
      } catch {}
      a.abort();
      ended();
    };
    const path = `/api/sessions/${encodeURIComponent(bridge)}/${encodeURIComponent(key)}/attach${terminal ? "?terminal" : ""}`;
    this.fetch(bridge, path, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body, signal: a.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`${res.status}`);
        await lines(res.body, (m) => !over && message(m), a.signal);
      })
      .catch(() => {})
      .finally(end);
    return {
      send: (m) => {
        if (!over) push.enqueue(enc.encode(JSON.stringify(m) + "\n"));
      },
      close: end,
    };
  }

  private tell(e: PeerEvent) {
    for (const fn of this.fns) fn(e);
  }

  private async look() {
    let devices: string[];
    try {
      devices = (await this.reach.devices()).devices;
    } catch {
      return;
    }
    for (const [device, a] of this.followed)
      if (!devices.includes(device)) {
        a.abort();
        this.followed.delete(device);
        this.forget(device, new Set());
      }
    for (const device of devices) if (!this.followed.has(device)) this.follow(device);
  }

  // The device's bridges but keep.
  private forget(device: string, keep: Set<string>) {
    for (const [id, b] of this.bridges)
      if (b.device === device && !keep.has(id)) {
        this.bridges.delete(id);
        this.tell({ id, gone: true });
      }
  }

  private follow(device: string) {
    const a = new AbortController();
    this.followed.set(device, a);
    void (async () => {
      for (let retry = 1000; !a.signal.aborted; retry = Math.min(retry * 2, 300_000)) {
        try {
          const res = await this.reach.fetch(device, "/api/sessions?follow", { signal: a.signal });
          if (!res.ok || !res.body) throw new Error(`${res.status}`);
          retry = 1000;
          await lines(res.body, (m) => {
            if (a.signal.aborted) return;
            if (m?.type === "bridges" && Array.isArray(m.bridges)) {
              const keep = new Set<string>();
              for (const b of m.bridges) if (this.put(device, b)) keep.add(b.id);
              this.forget(device, keep);
            } else if (m?.type === "bridge") {
              if (m.bridge?.gone) {
                if (this.bridges.get(m.bridge.id)?.device !== device) return;
                this.bridges.delete(m.bridge.id);
                this.tell({ id: m.bridge.id, gone: true });
              } else this.put(device, m.bridge);
            }
          }, a.signal);
        } catch {}
        if (!a.signal.aborted) await Bun.sleep(retry);
      }
    })();
  }

  private put(device: string, b: any): boolean {
    if (typeof b?.id !== "string" || !Array.isArray(b.sessions)) return false;
    const pb = { ...b, device } as PeerBridge;
    this.bridges.set(b.id, pb);
    this.tell(pb);
    return true;
  }
}
