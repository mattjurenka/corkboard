// Cards beside a Claude Code session that has its tab to itself
// (corkboard.claude.cards), drawn as the board draws them: the ones that
// session works on, blocked first, then the open cards ready to be picked
// up. j/k in the panel select one, and <CR> or a click opens it in the
// board's card float (rendered; e there edits it) without leaving the tab;
// a card's session and answer buttons go to its session or its question.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { type BoardCard, BoardCardView } from "./Board";
import type { ViewProps } from "./index";

type CardsState = { mine?: BoardCard[]; open?: BoardCard[]; selected?: string };

export function Cards({ state, focused, nvim }: ViewProps<CardsState>) {
  const ref = useRef<HTMLDivElement>(null);
  const go = (id: string) => nvim.lua("require('corkboard.claude.cards').go(...)", id);
  const open = (id: string) => nvim.lua("require('corkboard.claude.cards').open(...)", id);

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  const section = (title: string, cards: BoardCard[], first = false) => (
    <section className={cn(!first && "pt-row")}>
      <h2 className="mb-row">
        {title} <span className="text-muted-foreground">{cards.length}</span>
      </h2>
      <div className="flex flex-col gap-row pt-half">
        {cards.map((c) => (
          <BoardCardView
            key={c.id}
            card={c}
            selected={c.id === state.selected}
            focused={focused}
            onClick={() => open(c.id)}
            onSession={() => go(c.id)}
            onAnswer={() => go(c.id)}
          />
        ))}
        {!cards.length && <div className="px-ch text-border">—</div>}
      </div>
    </section>
  );

  return (
    <div ref={ref} className="h-full overflow-y-auto px-2ch pt-row pb-row">
      {section("this session", state.mine ?? [], true)}
      {section("ready to work on", state.open ?? [])}
    </div>
  );
}
