// What a resident (fleetd's assistant: Pepper) would do to a session or
// the fleet, held until the user says yes (.agent/plans/voice-call.md,
// step 3). Pepper reads mail and the web, so what it reads can tell it what
// to do, and a session is a shell: so the user decides, on their own side
// (an owner's client, or their voice heard by the node), never the resident.
//
// what is the node's own words for it, made from the arguments, so what
// the user is asked is what runs. Nothing's kept on disk: a node that
// restarts forgets what waited, and the resident asks again.

import { Invalid } from "./data";

export type Held = {
  id: string;
  agent: string;
  tool: string;
  what: string;
  at: number;
  state: "waiting" | "done" | "refused" | "failed" | "expired";
  result?: unknown;
  error?: string;
};

// How long one waits for the user, and how long its outcome is kept for
// the resident to ask after.
const WAIT = 10 * 60_000;
const KEEP = 60 * 60_000;
const MAX = 50;

export class Confirms {
  private held = new Map<string, { h: Held; run?: () => Promise<unknown> }>();
  private fns = new Set<(h: Held) => void>();

  constructor(private now = () => Date.now()) {}

  hold(agent: string, tool: string, what: string, run: () => Promise<unknown>): Held {
    this.sweep();
    if ([...this.held.values()].filter((x) => x.h.state === "waiting").length >= MAX) throw new Invalid(`${MAX} already wait for the user; ask them about those first`);
    const h: Held = { id: crypto.randomUUID().slice(0, 8), agent, tool, what, at: this.now(), state: "waiting" };
    this.held.set(h.id, { h, run });
    this.tell(h);
    return { ...h };
  }

  waiting(): Held[] {
    this.sweep();
    return [...this.held.values()].filter((x) => x.h.state === "waiting").map((x) => ({ ...x.h }));
  }

  get(id: string): Held | undefined {
    this.sweep();
    const x = this.held.get(id);
    return x && { ...x.h };
  }

  // The user's answer: yes runs it, now.
  async decide(id: string, ok: boolean): Promise<Held> {
    this.sweep();
    const x = this.held.get(id);
    if (!x) throw new Invalid(`nothing waits as ${id}`);
    if (x.h.state !== "waiting") throw new Invalid(`${id} is ${x.h.state} already`);
    const run = x.run!;
    x.run = undefined;
    x.h.at = this.now();
    if (!ok) x.h.state = "refused";
    else {
      // Taken before it runs, so a second yes can't run it twice.
      x.h.state = "done";
      try {
        x.h.result = await run();
      } catch (e) {
        x.h.state = "failed";
        x.h.error = (e as Error).message;
      }
    }
    this.tell(x.h);
    return { ...x.h };
  }

  // Each one held, and each decided or expired, from now; gives back the
  // way to stop.
  on(fn: (h: Held) => void): () => void {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }

  private tell(h: Held) {
    for (const fn of this.fns) fn({ ...h });
  }

  private sweep() {
    const now = this.now();
    for (const [id, x] of this.held) {
      if (x.h.state === "waiting" && now - x.h.at > WAIT) {
        x.h.state = "expired";
        x.h.at = now;
        x.run = undefined;
        this.tell(x.h);
      } else if (x.h.state !== "waiting" && now - x.h.at > KEEP) this.held.delete(id);
    }
  }
}
