// A scheduler for async code under test, in the spirit of loom and shuttle:
// whatever would happen "later" (a message on a socket, a chunk of a body, a
// reader giving up) is a task on a lane, and the scheduler picks which
// lane's next task runs, by a seeded random, letting every microtask settle
// between. One seed is one interleaving, run the same way every time.
//
// A lane keeps its own order, as a socket does; lanes interleave freely.
// Real timers never fire inside run(), so something waiting on one is
// still waiting when run() returns: that's a hang, and pending() names it.

import type { Gen } from "./fuzz";

type Task = () => unknown;

export class Sched {
  private lanes: Task[][] = [];
  private tracked: { label: string; settled: boolean }[] = [];
  steps = 0;

  constructor(readonly g: Gen) {}

  // A lane of its own: tasks put on it run in the order given.
  lane(): (t: Task) => void {
    const q: Task[] = [];
    this.lanes.push(q);
    return (t) => void q.push(t);
  }

  // One task, on a lane of its own.
  soon(t: Task) {
    this.lane()(t);
  }

  // Resolves when the scheduler gets round to it: a point where anything
  // else may happen first.
  yield(): Promise<void> {
    return new Promise((ok) => this.soon(ok));
  }

  // A promise whose settling is checked: unsettled once run() is done, it hung.
  track<T>(label: string, p: Promise<T>): Promise<T> {
    const t = { label, settled: false };
    this.tracked.push(t);
    p.then(
      () => (t.settled = true),
      () => (t.settled = true),
    );
    return p;
  }

  pending(): string[] {
    return this.tracked.filter((t) => !t.settled).map((t) => t.label);
  }

  // Runs tasks until there are none, or max of them (a livelock).
  async run(max = 100_000) {
    await settle();
    for (;;) {
      const ready = this.lanes.filter((q) => q.length);
      if (!ready.length) return;
      if (++this.steps > max) throw new Error(`still busy after ${max} steps`);
      const task = this.g.pick(ready).shift()!;
      // Not awaited: a task may wait on one still queued.
      try {
        void Promise.resolve(task()).catch(() => {});
      } catch {}
      await settle();
    }
  }
}

// Every microtask queued so far, and those they queue, run.
export const settle = () => new Promise<void>((ok) => setImmediate(ok));
