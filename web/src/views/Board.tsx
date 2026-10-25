// The board: columns of cards, each card a box with its pin and number set
// into the top border, and the keys along the bottom. Neovim owns the state
// and the keys (corkboard.board); clicks and the key hints call back into it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type BoardCard = {
  id: string;
  title: string;
  status: string;
  // None counts as medium.
  priority?: "high" | "medium" | "low";
  agent?: string;
  agent_state?: string;
  attention?: string;
  // Dependencies not done yet; missing ones name no card.
  waiting?: { id: string; missing: boolean }[];
  // The agent's Claude Code session, from its hooks (corkboard.agents).
  session?: "starting" | "working" | "idle" | "permission" | "exited";
  // What its agents' sessions cost (corkboard.usage's card_costs); cost is
  // missing until a session has recorded one.
  cost?: { cost?: number; tokens: number; sessions: number };
};

const costLine = (c: NonNullable<BoardCard["cost"]>) =>
  `${c.cost !== undefined ? `$${c.cost.toFixed(2)}` : "—"} · ${c.sessions} session${c.sessions === 1 ? "" : "s"}`;

const SESSION: Record<string, [string, string]> = {
  starting: ["starting", "text-muted-foreground"],
  working: ["running", "text-working"],
  idle: ["idle", "text-muted-foreground"],
  permission: ["asking permission", "text-blocked"],
  exited: ["session ended", "text-muted-foreground"],
};
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

// Each priority's color in the card's top border.
export const PRIORITY: Record<string, string> = {
  high: "text-blocked",
  medium: "text-foreground",
  low: "text-muted-foreground",
};

const KEYS = [
  ["new", "o", "New card"],
  ["priority", "p", "Priority"],
  ["left", "H", "Move left"],
  ["right", "L", "Move right"],
  ["assign", "a", "Hand to agent"],
  ["session", "s", "Session"],
  ["review", "v", "Review"],
  ["answer", "r", "Go to question"],
  ["open", "⏎", "Open"],
];

export function Board({ state, win, focused, nvim }: ViewProps<BoardState>) {
  const ref = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // The columns wrap onto more rows when the window is too narrow for them.
  // While they all fit on one, each fills the height and scrolls by itself;
  // once they wrap, the rows are as tall as their cards and scroll together.
  const [oneRow, setOneRow] = useState(true);
  const select = (id: string) => nvim.lua("require('corkboard.board').select(...)", id, win);
  const action = (name: string) => nvim.lua("require('corkboard.board').action(...)", name, win);

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.selected]);

  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const check = () => {
      const first = el.firstElementChild as HTMLElement | null;
      const last = el.lastElementChild as HTMLElement | null;
      setOneRow(!first || !last || first.offsetTop === last.offsetTop);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.statuses.length]);

  return (
    <div ref={ref} className="@container/board flex h-full flex-col px-2ch pt-row">
      <header className="truncate pb-row text-muted-foreground">{state.root ?? ""}</header>
      <div
        ref={grid}
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[repeat(auto-fit,minmax(min(22ch,100%),1fr))] gap-x-2ch",
          oneRow ? "grid-rows-[minmax(0,1fr)]" : "auto-rows-max gap-y-row overflow-y-auto",
        )}
      >
        {state.statuses.map((status) => {
          const cards = state.cards.filter((c) => c.status === status);
          const active = cards.some((c) => c.id === state.selected);
          return (
            <section key={status} className="flex min-h-0 flex-col">
              <h2 className={cn("mb-row", focused && active && "text-focus")}>
                {status} <span className="text-muted-foreground">{cards.length}</span>
              </h2>
              <div className={cn("flex flex-col gap-row pt-half", oneRow && "overflow-y-auto")}>
                {cards.map((c) => (
                  <BoardCardView
                    key={c.id}
                    card={c}
                    selected={c.id === state.selected}
                    focused={focused}
                    onClick={() => select(c.id).then(() => action("open"))}
                    onSession={() => select(c.id).then(() => action("session"))}
                    onAnswer={() => select(c.id).then(() => action("answer"))}
                  />
                ))}
                {!cards.length && oneRow && <div className="px-ch text-border">—</div>}
              </div>
            </section>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3ch border-t py-half @max-[64ch]/board:gap-x-2ch">
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
            <span className="lowercase @max-[64ch]/board:hidden">{label}</span>
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
  onSession,
  onAnswer,
  ...handlers
}: { card: BoardCard; selected: boolean; focused: boolean; onSession: () => void; onAnswer: () => void } & Pick<
  React.ComponentProps<"div">,
  "onClick"
>) {
  const s = card.agent_state ?? "";
  // A pin and the card's number, set into the top border.
  const number = /\d+$/.exec(card.id)?.[0];
  return (
    <Card
      data-selected={selected || undefined}
      className={cn(
        "relative cursor-pointer gap-0 px-ch pt-half pb-[calc(var(--cell-h)/2-1px)] hover:bg-accent",
        selected && "border-muted-foreground bg-selection hover:bg-selection",
        selected && focused && "border-focus",
      )}
      {...handlers}
    >
      <span className="absolute -top-half left-ch bg-background px-ch whitespace-nowrap text-muted-foreground">
        <span className={STATE_DOT[s] ?? "text-border"}>●</span>
        {number ? ` ${number}` : ""}
        {card.priority && <span className={PRIORITY[card.priority]}> {card.priority}</span>}
      </span>
      <div className={cn(selected && focused && "font-bold", card.waiting && "text-muted-foreground")}>{card.title}</div>
      {(card.agent || card.agent_state) && (
        <div className={STATE_AGENT[s] ?? "text-muted-foreground"}>
          {card.agent ?? "agent"} · {STATE_LABEL[s] ?? s}
        </div>
      )}
      {card.session && (
        <div
          title={card.session === "exited" ? undefined : "Go to the session (s)"}
          onClick={(e) => {
            if (card.session === "exited") return;
            e.stopPropagation();
            onSession();
          }}
          className={cn(SESSION[card.session]?.[1], card.session !== "exited" && "hover:underline")}
        >
          ⏵ {SESSION[card.session]?.[0] ?? card.session}
        </div>
      )}
      {card.cost && <div className="text-muted-foreground tabular-nums">{costLine(card.cost)}</div>}
      {card.attention && (
        <div className="text-blocked">
          ! {card.attention}{" "}
          <span
            title="Go to what the agent is asking (r)"
            onClick={(e) => {
              e.stopPropagation();
              onAnswer();
            }}
            className="whitespace-nowrap text-primary hover:underline"
          >
            ↩ go to it
          </span>
        </div>
      )}
      {card.waiting && (
        <div className="text-muted-foreground">
          └─ waits on{" "}
          {card.waiting.map((w, i) => (
            <span key={w.id}>
              {i > 0 && ", "}
              <span className={cn(w.missing && "text-blocked")} title={w.missing ? "No such card" : undefined}>
                {w.id}
                {w.missing && "?"}
              </span>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
