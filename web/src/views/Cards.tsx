// The cards agents are on, beside a Claude Code session that has its tab to
// itself (corkboard.claude.cards): one row a card, blocked first, this
// session's own marked. A click goes to the card's session, or to what it's
// asking, or to the card on the board. j/k in the panel select one, and <CR>
// opens it in the board's card float (rendered; e there edits it).

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { PRIORITY } from "./Board";
import type { ViewProps } from "./index";

type AgentCard = {
  id: string;
  title: string;
  priority?: "high" | "medium" | "low";
  agent_state: "queued" | "working" | "blocked" | "needs-review";
  attention?: string;
  // Its session's state (corkboard.agents' live): starting, working, idle,
  // asking, permission, exited.
  session?: string;
};
type CardsState = { cards: AgentCard[]; mine?: string; selected?: string };

const PIN: Record<string, [string, string]> = {
  blocked: ["●", "text-blocked"],
  working: ["●", "text-working animate-pulse-dot"],
  "needs-review": ["●", "text-review"],
  queued: ["○", "text-muted-foreground"],
};

const STATE_LABEL: Record<string, string> = {
  queued: "queued",
  working: "working",
  blocked: "blocked",
  "needs-review": "needs review",
};

// What a session's state adds to the card's, when it says more.
const SESSION: Record<string, string> = {
  asking: "asking you",
  permission: "wants permission",
  exited: "session ended",
};

export function Cards({ state, focused, nvim }: ViewProps<CardsState>) {
  const ref = useRef<HTMLDivElement>(null);
  const go = (id: string) => nvim.lua("require('corkboard.claude.cards').go(...)", id);
  const cards = state.cards ?? [];

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  return (
    <div className="flex h-full flex-col px-2ch pt-row">
      <header className="pb-row text-muted-foreground">
        cards agents are on <span className="text-border">{cards.length}</span>
      </header>
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
        {!cards.length && <div className="px-ch text-border">—</div>}
        {cards.map((c) => {
          const [pin, color] = PIN[c.agent_state] ?? ["·", "text-border"];
          const mine = c.id === state.mine;
          const selected = c.id === state.selected;
          const note = [STATE_LABEL[c.agent_state] ?? c.agent_state, c.session && SESSION[c.session]]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              key={c.id}
              data-selected={selected || undefined}
              onClick={() => go(c.id)}
              title={c.attention ? "Go to what the agent is asking" : "Go to the card's session"}
              className={cn(
                "grid cursor-pointer grid-cols-[2ch_1fr] px-ch hover:bg-accent",
                selected && "bg-selection hover:bg-selection",
                selected && focused && "shadow-[inset_2px_0_0_var(--color-primary)]",
              )}
            >
              <span className={color}>{pin}</span>
              <div className="min-w-0">
                <div className="truncate">
                  <span className="text-muted-foreground">{c.id}</span>{" "}
                  <span className={cn((mine || (selected && focused)) && "font-bold")}>{c.title}</span>
                </div>
                <div className={cn("truncate", c.agent_state === "blocked" ? "text-blocked" : "text-muted-foreground")}>
                  └─ {note}
                  {c.priority && <span className={PRIORITY[c.priority]}> · {c.priority}</span>}
                  {mine && <span className="text-primary"> · this session</span>}
                </div>
                {c.attention && <div className="text-blocked">! {c.attention}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
