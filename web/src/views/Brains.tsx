// The brains view: a card per brain, boxed with its name on the border, its
// memory's counts and what it holds. Drawn over agent://brains
// (corkboard.brains), which owns the cursor and the keys; a click selects,
// and a double click opens its memory, in Neovim.

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
  const open = (name: string) => nvim.lua("require('corkboard.brains').select(...); require('corkboard.brains').memory()", name, win);
  const cards = state.cards ?? [];

  return (
    <div className="relative h-full">
      <div ref={root} className="@container/brains flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
        <header className="flex justify-between gap-2ch text-muted-foreground">
          <span className="font-bold text-foreground">Brains</span>
          <span className="flex-none @max-[70ch]/brains:hidden">j/k · ⏎ memory · a new · e edit · d archive · u restore · P purge · R refresh</span>
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
                onDoubleClick={() => open(c.name)}
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

// A brain's memory: its notes by kind, the days of its log and its episodes,
// a recall's hits over them when there is one. Drawn over agent://brains/<name>
// (corkboard.brains), which owns the cursor and the keys; a click selects,
// and a double click opens, in Neovim.

type Item = { key: string };
type MemoryState = {
  buf: number;
  name: string;
  title: string;
  notes: { kind: string; notes: (Item & { id: string; title: string; ago?: string })[] }[];
  days: (Item & { day: string; entries: number })[];
  episodes: (Item & { ago?: string; agent: string; trigger: string; size: string; pending?: boolean })[];
  recall?: { query: string; hits: (Item & { title: string; kind?: string; snippet?: string; ago?: string })[] };
  selected?: string;
  problem?: string;
  loading?: boolean;
};

export function BrainMemory({ state, win, focused, nvim }: ViewProps<MemoryState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const select = (key: string, open = false) => nvim.lua("require('corkboard.brains').memory_select(...)", state.buf, key, win, open);
  const row = (key: string, children: React.ReactNode, className?: string) => {
    const on = key === state.selected;
    return (
      <li
        key={key}
        data-selected={on || undefined}
        onClick={() => select(key)}
        onDoubleClick={() => select(key, true)}
        className={cn("flex cursor-pointer gap-2ch px-ch", on && (focused ? "bg-primary/20" : "bg-accent"), className)}
      >
        {children}
      </li>
    );
  };
  const box = (title: string, children: React.ReactNode, label?: string) => (
    <section className="min-w-0 border px-ch pb-half">
      <h3 className="-mt-half flex justify-between gap-ch">
        <span className="bg-background px-half font-bold">{title}</span>
        {label && <span className="truncate bg-background px-half text-muted-foreground">{label}</span>}
      </h3>
      {children}
    </section>
  );
  const none = <p className="px-ch text-muted-foreground">none</p>;

  return (
    <div ref={root} className="@container/memory flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
      <header className="flex justify-between gap-2ch text-muted-foreground">
        <span className="truncate">
          <span className="font-bold text-foreground">{state.name}</span> · {state.title}
        </span>
        <span className="flex-none @max-[70ch]/memory:hidden">j/k · ⏎ open · / recall · esc clear · R refresh · q close</span>
      </header>
      {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
      {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
      {state.recall &&
        box(
          "recall",
          state.recall.hits.length ? (
            <ul>
              {state.recall.hits.map((h) =>
                row(
                  h.key,
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2ch">
                      <span className="truncate">
                        {h.title}
                        {h.kind && <span className="ml-ch text-muted-foreground">{h.kind}</span>}
                      </span>
                      <span className="flex-none text-muted-foreground">{h.ago}</span>
                    </span>
                    {h.snippet && <span className="block truncate text-muted-foreground">{h.snippet}</span>}
                  </span>,
                ),
              )}
            </ul>
          ) : (
            <p className="px-ch text-muted-foreground">nothing</p>
          ),
          state.recall.query,
        )}
      {!state.loading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(40ch,1fr))] items-start gap-x-2ch gap-y-row">
          {box(
            "notes",
            state.notes.length
              ? state.notes.map((k) => (
                  <div key={k.kind}>
                    <p className="text-review">{k.kind}</p>
                    <ul>
                      {k.notes.map((n) =>
                        row(
                          n.key,
                          <>
                            <span className="min-w-0 flex-1 truncate">{n.title}</span>
                            <span className="flex-none text-muted-foreground">{n.ago}</span>
                          </>,
                        ),
                      )}
                    </ul>
                  </div>
                ))
              : none,
          )}
          {box(
            "log",
            state.days.length ? (
              <ul>
                {state.days.map((d) =>
                  row(
                    d.key,
                    <>
                      <span className="flex-1">{d.day}</span>
                      <span className="text-muted-foreground">{d.entries === 1 ? "1 entry" : `${d.entries} entries`}</span>
                    </>,
                  ),
                )}
              </ul>
            ) : (
              none
            ),
          )}
          {box(
            "episodes",
            state.episodes.length ? (
              <ul>
                {state.episodes.map((e) =>
                  row(
                    e.key,
                    <>
                      <span className="w-[8ch] flex-none text-muted-foreground">{e.ago}</span>
                      <span className="min-w-0 flex-1 truncate">{e.agent}</span>
                      <span className="flex-none text-muted-foreground">{e.trigger}</span>
                      <span className="flex-none text-muted-foreground">{e.size}</span>
                      {e.pending && <span className="flex-none text-primary">pending</span>}
                    </>,
                  ),
                )}
              </ul>
            ) : (
              none
            ),
          )}
        </div>
      )}
    </div>
  );
}
