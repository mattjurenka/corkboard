// What changed among the fleet's spawns and sessions, for /mcp's wait_for and
// for the desktop notification of a spawn that ended.
//
// The queue is the Worker's and says nothing when a spawn changes; this asks.
// One loop per node, whatever the number of waiters, and only while someone
// is waiting or a spawn asked to be told of (spawn_agent's notify) hasn't
// ended: waiting costs a timer and a promise, not a request. What it has seen
// is in memory: after a restart a spawn that ended meanwhile is told only to
// a wait_for that names it.

export type Seen = { id: string; state: string; board?: string | null; card?: string | null; template?: string; result?: string | null; error?: string | null; task?: string };
export type Change = { seq: number; id: string; from: string | null; state: string; board: string | null; card: string | null; summary: string };

// The states that call for the user: a spawn that ended, or a session
// waiting on an answer or a permission. Others (queued, running) are
// changes too, to a wait_for, but raise no notification.
export const NOTABLE = new Set(["done", "failed", "stopped", "asking", "permission"]);
const ENDED = new Set(["done", "failed", "stopped"]);

export const POLL_MS = 3000;
export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 300_000;
const MAX_WAITERS = 64;
const KEEP = 200;

const line = (s: unknown) => String(s ?? "").trim().split("\n")[0].slice(0, 160);

function say(s: Seen) {
  if (s.state === "failed") return `failed: ${line(s.error) || line(s.result) || "no reason given"}`;
  if (s.state === "done") return line(s.result) ? `done: ${line(s.result)}` : "done";
  return s.state;
}

type Waiter = { ids: Set<string> | null; resolve: (c: Change[]) => void; timer: ReturnType<typeof setTimeout> };

export class SpawnWatch {
  private seen = new Map<string, Seen>();
  private events: Change[] = [];
  private seq = 0;
  private waiters = new Set<Waiter>();
  // Spawns whose end is to be notified, though nobody waits.
  private told = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private primed = false;

  constructor(
    // The newest spawns, and one by id, as the Worker's /fleet/status gives them (words opened).
    private look: () => Promise<Seen[]>,
    private one: (id: string) => Promise<Seen | undefined>,
    private notify: (c: Change) => Promise<void> | void,
    private every = POLL_MS,
  ) {}

  get cursor() {
    return this.seq;
  }

  // A spawn whose end (or question) is to raise a notification even when no one waits.
  tell(id: string) {
    this.told.add(id);
    this.start();
  }

  private matches(ids: Set<string> | null, c: Change) {
    return !ids || ids.has(c.id);
  }

  // Changes after since (this call's start, when left out) to ids (any, when
  // empty), once there's one or the wait is over. Without since, a named spawn
  // that has already ended answers at once.
  async wait(ids: string[], ms: number, since?: number): Promise<{ changes: Change[]; cursor: number }> {
    const want = ids.length ? new Set(ids) : null;
    if (this.waiters.size >= MAX_WAITERS) throw new Error(`${MAX_WAITERS} are waiting already; try again shortly`);
    const ready = async () => {
      if (since !== undefined) return this.events.filter((c) => c.seq > since && this.matches(want, c));
      const done: Change[] = [];
      for (const id of ids) {
        const s = this.seen.get(id) ?? (await this.one(id).catch(() => undefined));
        if (s) this.remember(s, false);
        const now = this.seen.get(id);
        if (now && NOTABLE.has(now.state)) done.push({ seq: this.seq, id, from: null, state: now.state, board: now.board ?? null, card: now.card ?? null, summary: say(now) });
      }
      return done;
    };
    const first = await ready();
    if (first.length) return { changes: first, cursor: this.seq };
    const from = this.seq;
    const changes = await new Promise<Change[]>((resolve) => {
      const w: Waiter = {
        ids: want,
        resolve: (c) => {
          clearTimeout(w.timer);
          this.waiters.delete(w);
          this.stop();
          resolve(c);
        },
        timer: setTimeout(() => w.resolve([]), Math.min(Math.max(ms, 1), MAX_WAIT_MS)),
      };
      this.waiters.add(w);
      this.start();
    });
    // What changed while this waited, for the ids it named.
    return { changes: changes.length ? changes : this.events.filter((c) => c.seq > from && this.matches(want, c)), cursor: this.seq };
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.every);
    void this.poll();
  }

  private stop() {
    if (this.waiters.size || this.told.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.primed = false;
    this.seen.clear();
  }

  private remember(s: Seen, emit: boolean) {
    const was = this.seen.get(s.id);
    this.seen.set(s.id, s);
    if (!emit || !this.primed || (was && was.state === s.state)) return;
    const c: Change = { seq: ++this.seq, id: s.id, from: was?.state ?? null, state: s.state, board: s.board ?? null, card: s.card ?? null, summary: say(s) };
    this.events.push(c);
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP);
    for (const w of [...this.waiters]) if (this.matches(w.ids, c)) w.resolve([c]);
    if (NOTABLE.has(s.state)) void Promise.resolve(this.notify(c)).catch(() => {});
    if (ENDED.has(s.state)) this.told.delete(s.id);
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await this.look();
      const listed = new Set(list.map((s) => s.id));
      // A named spawn the newest don't include.
      const named = new Set<string>([...this.told, ...[...this.waiters].flatMap((w) => [...(w.ids ?? [])])]);
      const extra: Seen[] = [];
      for (const id of named) {
        const was = this.seen.get(id);
        if (listed.has(id) || (was && ENDED.has(was.state))) continue;
        const s = await this.one(id).catch(() => undefined);
        if (s) extra.push(s);
      }
      for (const s of [...list, ...extra]) this.remember(s, true);
      this.primed = true;
    } catch {
      // The Worker's out of reach: the next look tries again.
    } finally {
      this.busy = false;
      this.stop();
    }
  }
}
