// A working card's claim, as the Worker's board.ts keeps it: it lasts
// LEASE_MS past the later of the card's last change and its agent's last
// word (a board call over /mcp, or corkboard's heartbeat while its session
// runs, app.ts's touch). Then the node that leads marks the card blocked for
// the user, since the agent likely died. The word is kept in the board
// replica beside the card (board.ts's lease:<card>), so the leader hears
// what another node did.
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
// LEASE_MS. A card the leader marked blocked is working again. null when
// agent doesn't hold the card or it isn't one whose claim can lapse.
export async function touch(data: Data, board: string, id: string, agent: string, at = Date.now()): Promise<{ until: number } | null> {
  const c = data.card(board, id);
  if (c.agent !== agent || c.archived) return null;
  const had = data.lease(board, id);
  const lapsed = had?.agent === agent && had.lapsed;
  if (c.agent_state === "blocked" && lapsed) {
    await data.updateCard(board, id, { agent_state: "working", attention: null });
    await data.appendLog(board, id, "corkboard", `${agent} is responding again, so it's back to working`);
  } else if (c.agent_state !== "working") return null;
  const until = at + LEASE_MS;
  if (!had || had.agent !== agent || had.lapsed || until - had.until >= EVERY) await data.setLease(board, id, { agent, until, lapsed: false });
  return { until };
}

// Each working card past its deadline is blocked, for the user to queue
// again or release; its worktree and branch are left as they are. Not one
// the budget guard stopped, which waits on the user already. The cards
// blocked, as board:id.
export async function sweep(data: Data, at = Date.now()): Promise<string[]> {
  const blocked: string[] = [];
  for (const { key } of data.boards())
    for (const c of data.cards(key)) {
      if (c.agent_state !== "working" || !c.agent || c.extra.budget_hold) continue;
      const lease = data.lease(key, c.id);
      if (lease?.agent !== c.agent || Math.max(Date.parse(c.updated) + LEASE_MS, lease.until) > at) continue;
      await data.updateCard(key, c.id, { agent_state: "blocked", attention: `${c.agent} stopped responding; queue it again or release it` });
      await data.setLease(key, c.id, { agent: c.agent, until: at, lapsed: true });
      await data.appendLog(
        key,
        c.id,
        "corkboard",
        `nothing from ${c.agent} for ${LEASE_MS / 60_000} minutes, so it's marked blocked: the agent likely stopped. Queue it again to restart it, or release it.`,
      );
      blocked.push(`${key}:${c.id}`);
    }
  return blocked;
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
