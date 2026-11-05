// The node's consolidator: what turns a brain's episodes into its log, and
// its log into its long-term memory, on the machine that recorded them
// (.agent/plans/local-memory.md). The Worker's (corkboard-cloud's
// memory.ts), over Episodes and Data; the prompts and the checks on what
// comes back are lib/memory/consolidate.ts's.
//
// Every minute or so it looks at each brain on the node: once the episodes
// waiting have been quiet for QUIET, it reads them, a few at a time; with
// none waiting and a day turned over on a log not yet rolled up, it rewrites
// the memory from it. The thinking is `think`: `claude -p` with no tools, on
// the user's own account. After a run that failed, the next waits an hour,
// then two, up to a day.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTEMPTS, DAY_CHARS, QUIET, ROLLUP_DAYS, bullets, flushInput, flushPrompt, parseRollup, render, rollupInput, rollupPrompt } from "../../lib/memory/consolidate";
import type { Data } from "./data";
import type { Episode, Episodes } from "./episodes";
import type { Handoff } from "./handoff";
import { before, logText } from "./search";

// A system prompt and an input, to the text that comes back.
export type Think = (prompt: string, input: string) => Promise<string>;

const THINK_TIMEOUT = 10 * 60_000;

// One Claude Code run with no tools, MCP servers or settings, in an empty
// directory, the input on stdin; CORKBOARD_NO_MEMORY keeps its own hooks
// from sending it back as an episode.
export const claudeThink: Think = async (prompt, input) => {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-think-"));
  try {
    const file = join(dir, "system.md");
    writeFileSync(file, prompt, { mode: 0o600 });
    const p = Bun.spawn(
      ["claude", "-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt-file", file, "--output-format", "json"],
      { cwd: dir, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, CORKBOARD_NO_MEMORY: "1" } },
    );
    const timer = setTimeout(() => p.kill(), THINK_TIMEOUT);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 500)}`);
    const j = JSON.parse(out) as { result?: unknown; is_error?: boolean };
    if (j.is_error || typeof j.result !== "string") throw new Error(`claude -p: ${String(j.result ?? "no result").slice(0, 500)}`);
    return j.result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// after: once a brain's run has finished (serve.ts embeds what it wrote).
// leads: whether this node is the one to roll up, the account's others
// having the same log (serve.ts: the node the tunnel goes to); always,
// without it. handoff: where a node that doesn't lead gives its episodes,
// and the one that does takes them (handoff.ts); without it, each node
// reads its own.
export type ConsolidatorOptions = {
  data: Data;
  episodes: Episodes;
  think?: Think;
  now?: () => number;
  every?: number;
  after?: (brain: string) => Promise<void>;
  leads?: () => Promise<boolean>;
  handoff?: Pick<Handoff, "give" | "take">;
};

export class Consolidator {
  private readonly data: Data;
  private readonly episodes: Episodes;
  private readonly think: Think;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private o: ConsolidatorOptions) {
    this.data = o.data;
    this.episodes = o.episodes;
    this.think = o.think ?? claudeThink;
    this.now = o.now ?? Date.now;
    // Read once it's quiet.
    o.episodes.onAdded = (brain) => o.episodes.setMeta(brain, "consolidate_at", String(this.now() + QUIET));
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.o.every ?? 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    await this.running;
  }

  // Each brain in turn, one run at a time.
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const b of this.data.brains()) await this.tend(b.name);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async tend(brain: string) {
    try {
      if (this.o.handoff && (await this.leads())) await this.o.handoff.take(brain);
      if (!(await this.due(brain))) return;
      if (Number(this.episodes.meta(brain, "consolidate_after") ?? 0) > this.now()) return;
    } catch (e) {
      return console.error(`consolidate: ${brain}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.consolidate(brain);
      this.episodes.setMeta(brain, "consolidate_failures", "0");
      await this.o.after?.(brain).catch((e) => console.error(`consolidate: ${brain}: after: ${e instanceof Error ? e.message : e}`));
    } catch (e) {
      const failures = Number(this.episodes.meta(brain, "consolidate_failures") ?? 0) + 1;
      this.episodes.setMeta(brain, "consolidate_failures", String(failures));
      this.episodes.setMeta(brain, "consolidate_after", String(this.now() + Math.min(3600_000 * 2 ** (failures - 1), 86_400_000)));
      console.error(`consolidate: ${brain}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Everything waiting: the episodes, then a rollup if one is due; or,
  // another node leading, the episodes handed to it.
  async consolidate(brain: string) {
    if (this.o.handoff && !(await this.leads())) return this.handOver(brain);
    for (;;) {
      const c = await this.consolidation(brain);
      for (const e of c.episodes) await this.consolidated(brain, e.episode, await this.think(e.prompt, e.input));
      if (c.episodes.length) continue;
      if (c.rollup) await this.rolledUp(brain, c.rollup.through, c.rollup.version, await this.think(c.rollup.prompt, c.rollup.input));
      return;
    }
  }

  private async leads() {
    return (await this.o.leads?.().catch(() => true)) ?? true;
  }

  private today() {
    return this.data.dayOf(new Date(this.now()).toISOString());
  }

  // The days the next rollup reads: those since the last one's (by any
  // machine of the account), up to yesterday, and never more than
  // ROLLUP_DAYS of them.
  private rollupDays(brain: string): { from: string; through: string } | null {
    const through = before(this.today(), 1);
    const last = this.data.rolled(brain);
    const earliest = before(through, ROLLUP_DAYS - 1);
    const from = last && last >= earliest ? before(last, -1) : earliest;
    return from <= through ? { from, through } : null;
  }

  // Whether the consolidator is worth running: the episodes waiting are
  // quiet, or a rollup is due. Days turned over with no log are rolled past.
  private async due(brain: string): Promise<boolean> {
    if (this.episodes.list(brain, 1, true).length) return Number(this.episodes.meta(brain, "consolidate_at") ?? 0) <= this.now();
    const days = this.rollupDays(brain);
    if (!days) return false;
    if (this.data.entries(brain, days.from, days.through).length) return this.leads();
    if (this.data.entries(brain).length) await this.data.setRolled(brain, days.through);
    return false;
  }

  // What to do next: a few of the episodes waiting, each the part of its
  // session not yet read; with none waiting, the log of the days since the
  // last rollup and the long-term memory to rewrite from it. An episode with
  // nothing to read is done with here; one tried ATTEMPTS times without an
  // answer, let go of.
  async consolidation(brain: string) {
    const b = this.data.brain(brain);
    const who = { name: brain, title: b.title, description: b.description, timezone: this.data.timeZone };
    const memory = this.data.note(brain, "memory");
    const episodes: { episode: Episode; prompt: string; input: string }[] = [];
    for (const e of this.episodes.list(brain, 200, true, true)) {
      if (episodes.length >= 3) break;
      const { text, through } = render(this.episodes.transcript(brain, e.id) ?? "", this.episodes.through(brain, e.session));
      // Older than the rollup reaches, kept as it is.
      const old = e.at < before(this.today(), ROLLUP_DAYS) + "T00:00:00Z";
      if (!text.trim() || e.attempts >= ATTEMPTS || old) {
        if (text.trim() && !old) console.error(`consolidate: ${brain}: let go of episode ${e.id} after ${e.attempts} tries`);
        this.episodes.finish(brain, e.id, e.session, through);
        continue;
      }
      this.episodes.tried(brain, e.id);
      episodes.push({ episode: e, prompt: flushPrompt(who), input: flushInput(memory?.body ?? "", text) });
    }
    if (episodes.length) return { episodes, rollup: null };

    const days = this.rollupDays(brain);
    const log = days ? this.data.entries(brain, days.from, days.through) : [];
    if (!days || !log.length || !(await this.leads())) return { episodes, rollup: null };
    return {
      episodes,
      rollup: { through: days.through, version: memory?.version ?? 0, prompt: rollupPrompt(who), input: rollupInput(memory?.body ?? "", logText(log, this.data.timeZone, false, DAY_CHARS)) },
    };
  }

  // An episode's answer: its bullets in the log, on the day its part of the
  // session ended, each kept once however often it's written. An episode a
  // newer upload of its session replaced meanwhile is let be.
  async consolidated(brain: string, e: Episode, text: string): Promise<number> {
    const transcript = this.episodes.transcript(brain, e.id);
    if (transcript === undefined) return 0;
    const { through } = render(transcript, this.episodes.through(brain, e.session));
    const at = through ?? e.at;
    const added = await this.data.addEntries(
      brain,
      bullets(text).map((b, n) => ({ at, who: e.agent, text: b, key: `episode:${e.id}:${n}` })),
    );
    this.episodes.finish(brain, e.id, e.session, through);
    return added;
  }

  // The episodes waiting, given to the node that leads, each marked read
  // here as far as it goes, so what this node reads later of the same
  // session starts after it.
  private async handOver(brain: string) {
    for (const e of this.episodes.list(brain, 200, true, true)) {
      const transcript = this.episodes.transcript(brain, e.id) ?? "";
      const was = this.episodes.through(brain, e.session);
      const { text, through } = render(transcript, was);
      if (text.trim()) await this.o.handoff!.give(brain, e, transcript, was);
      this.episodes.finish(brain, e.id, e.session, through);
    }
  }

  // A rollup's answer: the long-term memory rewritten, over the version it
  // was given; suggestions for the soul go in the log for the user to take
  // up by hand, since the soul is never the consolidator's to write.
  async rolledUp(brain: string, through: string, version: number, text: string) {
    const days = this.rollupDays(brain);
    if (!days || through < days.from || through > days.through) throw new Error(`nothing to roll up through ${through}`);
    const was = this.data.note(brain, "memory");
    const r = parseRollup(text, was?.body ?? "");
    if ("error" in r) throw new Error(r.error);
    const put = await this.data.putNote(brain, "memory", { kind: "memory", title: was?.title ?? "Long-term memory", body: r.memory }, version);
    const at = new Date(this.now()).toISOString();
    await this.data.addEntries(
      brain,
      r.suggestions.map((s, n) => ({ at, who: "consolidator", text: `Suggested for the soul: ${s}`, key: `rollup:${through}:${n}` })),
    );
    await this.data.setRolled(brain, through);
    return put;
  }
}
