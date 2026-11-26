// A working card's claim, as the Worker's board.ts keeps it: it lasts
// LEASE_MS past the later of the card's last change and its agent's last
// word (a board call over /mcp, or corkboard's heartbeat while its session
// is mid-turn, app.ts's touch). Then the node that leads releases the card:
// back to ready with nobody on it, for the next agent, since this one
// stopped or sits idle. The word is kept in the board replica beside the
// card (board.ts's lease:<card>), so the leader hears what another node did.
//
// A claim no node has heard a word for is left alone: it's a board still
// the Worker's, whose copy here (e2ee push-board's) its agents don't call.

import type { Data } from "./data";

export const LEASE_MS = 15 * 60_000;
// A word is written at most this often for a card; the claim holds between.
const EVERY = 60_000;
// How often the leader looks for lapsed claims.
const SWEEP_MS = 60_000;

// The agent holding the card was heard from: its claim holds another
// LEASE_MS. null when agent doesn't hold the card or isn't working on it
// (one released for its silence is nobody's, and is claimed again).
export async function touch(data: Data, board: string, id: string, agent: string, at = Date.now()): Promise<{ until: number } | null> {
  const c = data.card(board, id);
  if (c.agent !== agent || c.archived || c.agent_state !== "working") return null;
  const had = data.lease(board, id);
  const until = at + LEASE_MS;
  if (!had || had.agent !== agent || had.lapsed || until - had.until >= EVERY) await data.setLease(board, id, { agent, until, lapsed: false });
  return { until };
}

// Each working card past its deadline is released: ready again and
// nobody's, as release_card leaves it; its worktree and branch are left as
// they are, for whoever claims it next. Not one the budget guard stopped,
// which waits on the user already. The cards released, as board:id.
export async function sweep(data: Data, at = Date.now()): Promise<string[]> {
  const released: string[] = [];
  for (const { key } of data.boards())
    for (const c of data.cards(key)) {
      if (c.agent_state !== "working" || !c.agent || c.extra.budget_hold) continue;
      const lease = data.lease(key, c.id);
      if (lease?.agent !== c.agent || Math.max(Date.parse(c.updated) + LEASE_MS, lease.until) > at) continue;
      await data.updateCard(key, c.id, { status: "ready", agent: null, agent_state: null, attention: null });
      await data.setLease(key, c.id, { agent: c.agent, until: at, lapsed: true });
      await data.appendLog(key, c.id, "corkboard", `released: nothing from ${c.agent} for ${LEASE_MS / 60_000} minutes, so it's back in ready for the next agent`);
      released.push(`${key}:${c.id}`);
    }
  return released;
}

// Sweeps while the node leads (serve.ts's leads); gives back the way to stop.
export function startLeases(data: Data, leads: () => Promise<boolean>): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (await leads()) await sweep(data);
    } catch (e) {
      console.error(`node: leases: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, SWEEP_MS);
  return () => clearInterval(timer);
}
