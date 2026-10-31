// The brains view: a card per brain, boxed with its name on the border, its
// memory's counts and what it holds. Drawn over agent://brains
// (corkboard.brains), which owns the cursor and the keys; a click selects,
// and a double click edits, in Neovim.

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Card = {
  name: string;
  title: string;
  description?: string;
  account?: string;
  default?: boolean;
  archived?: string;
  credentials: string[];
  abilities: string[];
  egress: string[];
  memory: { notes: number; entries: number; episodes: number; last?: string };
};
type BrainsState = { cards: Card[]; selected?: string; asking?: { name: string }; problem?: string; loading?: boolean };

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Brains({ state, win, focused, nvim }: ViewProps<BrainsState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (name: string) => nvim.lua("require('corkboard.brains').select(...)", name, win);
  const edit = (name: string) => nvim.lua("require('corkboard.brains').select(...); require('corkboard.brains').edit()", name, win);
  const cards = state.cards ?? [];

  return (
    <div className="relative h-full">
      <div ref={root} className="@container/brains flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
        <header className="flex justify-between gap-2ch text-muted-foreground">
          <span className="font-bold text-foreground">Brains</span>
          <span className="flex-none @max-[70ch]/brains:hidden">j/k · a new · e edit · d archive · u restore · P purge · R refresh</span>
        </header>
        {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
        {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(40ch,1fr))] items-start gap-x-2ch gap-y-row">
          {cards.map((c) => {
            const on = c.name === state.selected;
            const label = [c.default && "default", c.account, c.archived && `archived ${c.archived}`].filter(Boolean).join(" · ");
            const m = c.memory;
            return (
              <section
                key={c.name}
                data-selected={on || undefined}
                onClick={() => pick(c.name)}
                onDoubleClick={() => edit(c.name)}
                className={cn("min-w-0 cursor-pointer border px-ch pb-half", on && "border-primary", c.archived && "opacity-60")}
              >
                <h3 className="-mt-half flex justify-between gap-ch">
                  <span className={cn("truncate bg-background px-half font-bold", on && focused && "text-primary")}>{c.name}</span>
                  {label && <span className="flex-none bg-background px-half text-muted-foreground">{label}</span>}
                </h3>
                <p className="truncate">{c.title}</p>
                {c.description && <p className={cn("text-muted-foreground", on ? "whitespace-pre-wrap" : "truncate")}>{c.description}</p>}
                <p className="text-muted-foreground">
                  {count(m.notes)} notes · {count(m.entries)} entries · {count(m.episodes)} episodes{m.last && ` · ${m.last}`}
                </p>
                {(c.credentials.length > 0 || c.abilities.length > 0) && (
                  <p className="truncate">
                    {c.credentials.map((x) => (
                      <span key={x} className="mr-ch text-review">
                        {x}
                      </span>
                    ))}
                    {c.abilities.map((x) => (
                      <span key={x} className="mr-ch text-primary">
                        {x}
                      </span>
                    ))}
                  </p>
                )}
                {on && c.egress.length > 0 && <p className="break-words text-muted-foreground">{c.egress.join(" ")}</p>}
              </section>
            );
          })}
        </div>
      </div>
      {state.asking && <Ask name={state.asking.name} onAnswer={(yes) => nvim.lua("require('corkboard.brains').answer(...)", yes)} />}
    </div>
  );
}

// d's question, boxed in the middle of the view; y or n answer it there too.
function Ask({ name, onAnswer }: { name: string; onAnswer: (yes: boolean) => void }) {
  return (
    <div className="absolute inset-0 z-2 flex items-center justify-center bg-background/60">
      <section className="max-w-[min(60ch,calc(100%-4ch))] border border-primary bg-background px-2ch pb-half">
        <h2 className="-mt-half flex">
          <span className="bg-background px-half font-bold text-primary">archive</span>
        </h2>
        <p className="break-words">Archive {name}? Its memory is kept.</p>
        <p className="mt-row flex justify-end gap-2ch">
          <button type="button" onClick={() => onAnswer(true)} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">y</span> yes
          </button>
          <button type="button" onClick={() => onAnswer(false)} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">n</span> no
          </button>
        </p>
      </section>
    </div>
  );
}
