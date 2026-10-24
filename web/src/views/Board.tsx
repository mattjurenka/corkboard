// The board: columns of cards, each card a box with its pin and number set
// into the top border, and the keys along the bottom. Neovim owns the state
// and the keys (corkboard.board); clicks and the key hints call back into it.

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type BoardCard = { id: string; title: string; status: string; agent?: string; agent_state?: string; attention?: string };
type BoardState = { root?: string; statuses: string[]; cards: BoardCard[]; selected?: string };

const STATE_LABEL: Record<string, string> = {
  queued: "queued",
  working: "working",
  blocked: "blocked",
  "needs-review": "needs review",
  done: "done",
};

// The pin's color, and the agent line's, for each agent_state.
const STATE_DOT: Record<string, string> = {
  queued: "text-muted-foreground",
  working: "text-working animate-pulse-dot",
  blocked: "text-blocked",
  "needs-review": "text-review",
  done: "text-working",
};
const STATE_AGENT: Record<string, string> = {
  working: "text-working",
  blocked: "text-blocked",
  "needs-review": "text-review",
};

const KEYS = [
  ["new", "o", "New card"],
  ["left", "H", "Move left"],
  ["right", "L", "Move right"],
  ["assign", "a", "Hand to agent"],
  ["open", "⏎", "Open"],
];

export function Board({ state, win, focused, nvim }: ViewProps<BoardState>) {
  const ref = useRef<HTMLDivElement>(null);
  const select = (id: string) => nvim.lua("require('corkboard.board').select(...)", id, win);
  const action = (name: string) => nvim.lua("require('corkboard.board').action(...)", name, win);

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.selected]);

  return (
    <div ref={ref} className="flex h-full flex-col px-2ch pt-row">
      <header className="truncate pb-row text-muted-foreground">{state.root ?? ""}</header>
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(22ch,1fr)] grid-flow-col gap-x-2ch overflow-x-auto">
        {state.statuses.map((status) => {
          const cards = state.cards.filter((c) => c.status === status);
          const active = cards.some((c) => c.id === state.selected);
          return (
            <section key={status} className="flex min-h-0 flex-col">
              <h2 className={cn("mb-row", focused && active && "text-primary")}>
                {status} <span className="text-muted-foreground">{cards.length}</span>
              </h2>
              <div className="flex flex-col gap-row overflow-y-auto pt-half">
                {cards.map((c) => (
                  <BoardCardView
                    key={c.id}
                    card={c}
                    selected={c.id === state.selected}
                    focused={focused}
                    onClick={() => select(c.id)}
                    onDoubleClick={() => action("open")}
                  />
                ))}
                {!cards.length && <div className="px-ch text-border">—</div>}
              </div>
            </section>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3ch border-t py-half">
        {KEYS.map(([name, key, label]) => (
          <Button
            key={name}
            variant="link"
            size="cell"
            title={`${label} (${key})`}
            onClick={() => action(name)}
            className="px-0 text-muted-foreground hover:text-foreground hover:no-underline"
          >
            <kbd className="text-primary">{key}</kbd>
            <span className="lowercase">{label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function BoardCardView({
  card,
  selected,
  focused,
  ...handlers
}: { card: BoardCard; selected: boolean; focused: boolean } & Pick<React.ComponentProps<"div">, "onClick" | "onDoubleClick">) {
  const s = card.agent_state ?? "";
  // A pin and the card's number, set into the top border.
  const number = /^\d+/.exec(card.id)?.[0];
  return (
    <Card
      data-selected={selected || undefined}
      className={cn(
        "relative cursor-pointer gap-0 px-ch pt-half pb-[calc(var(--cell-h)/2-1px)] hover:bg-accent",
        selected && "border-muted-foreground bg-selection hover:bg-selection",
        selected && focused && "border-primary",
      )}
      {...handlers}
    >
      <span className="absolute -top-half left-ch bg-background px-ch whitespace-nowrap text-muted-foreground">
        <span className={STATE_DOT[s] ?? "text-border"}>●</span>
        {number ? ` ${number}` : ""}
      </span>
      <div className={cn(selected && focused && "font-bold")}>{card.title}</div>
      {(card.agent || card.agent_state) && (
        <div className={STATE_AGENT[s] ?? "text-muted-foreground"}>
          {card.agent ?? "agent"} · {STATE_LABEL[s] ?? s}
        </div>
      )}
      {card.attention && <div className="text-blocked">! {card.attention}</div>}
    </Card>
  );
}
