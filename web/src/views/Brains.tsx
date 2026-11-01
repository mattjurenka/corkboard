// The brains view: a card per brain, boxed with its title on the border,
// what it's for, its particulars as labelled fields, and what you can do with
// it as buttons along its foot; archived brains under their own heading.
// Drawn over agent://brains (corkboard.brains), which owns the cursor and the
// keys; a click selects, a button acts on its brain, and a double click opens
// its memory, in Neovim.

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
type Act = "memory" | "edit" | "archive" | "restore" | "purge";

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

export function Brains({ state, win, focused, nvim }: ViewProps<BrainsState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (name: string) => nvim.lua("require('corkboard.brains').select(...)", name, win);
  const act = (name: string, what: Act) => nvim.lua("require('corkboard.brains').act(...)", name, what, win);
  const make = () => nvim.lua("require('corkboard.brains').new()");
  const cards = state.cards ?? [];
  const live = cards.filter((c) => !c.archived);
  const archived = cards.filter((c) => c.archived);
  const grid = (list: Card[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(44ch,1fr))] items-start gap-x-2ch gap-y-row">
      {list.map((c) => (
        <BrainCard key={c.name} card={c} on={c.name === state.selected} focused={focused} onPick={pick} onAct={act} />
      ))}
    </div>
  );

  return (
    <div className="relative h-full">
      <div ref={root} className="@container/brains flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
        <header className="flex items-baseline justify-between gap-2ch">
          <span className="font-bold">Brains</span>
          <Button k="a" lit onClick={make}>
            new brain
          </Button>
        </header>
        {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
        {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
        {!state.loading && !state.problem && live.length === 0 && <p className="px-ch text-muted-foreground">No brains.</p>}
        {live.length > 0 && grid(live)}
        {archived.length > 0 && (
          <section className="flex flex-col gap-row">
            <h2 className="text-muted-foreground">Archived</h2>
            {grid(archived)}
          </section>
        )}
      </div>
      {state.asking && <Ask name={state.asking.name} onAnswer={(yes) => nvim.lua("require('corkboard.brains').answer(...)", yes)} />}
    </div>
  );
}

// One brain: its title (and name, where that differs) and whether it's the
// default on the border, what it's for, its fields, and its actions, whose
// keys light up on the selected one, where they work.
function BrainCard({
  card: c,
  on,
  focused,
  onPick,
  onAct,
}: {
  card: Card;
  on: boolean;
  focused: boolean;
  onPick: (name: string) => void;
  onAct: (name: string, what: Act) => void;
}) {
  const m = c.memory;
  const empty = m.notes + m.entries + m.episodes === 0;
  const reach = on ? c.egress : c.egress.slice(0, 2);
  const button = (k: string, what: Act, label: string, danger?: boolean) => (
    <Button k={k} lit={on} danger={danger} onClick={() => onAct(c.name, what)}>
      {label}
    </Button>
  );
  return (
    <section
      data-selected={on || undefined}
      onClick={() => onPick(c.name)}
      onDoubleClick={() => !c.archived && onAct(c.name, "memory")}
      className={cn("flex min-w-0 cursor-pointer flex-col border px-ch pb-half", on && "border-primary", c.archived && "opacity-60")}
    >
      <h3 className="-mt-half flex justify-between gap-ch">
        <span className={cn("truncate bg-background px-half", on && focused && "text-primary")}>
          <span className="font-bold">{c.title}</span>
          {c.name !== c.title.toLowerCase() && <span className="text-muted-foreground"> {c.name}</span>}
        </span>
        {c.default && (
          <span className="flex-none bg-background px-half text-working" title="Your own sessions remember here">
            ● default
          </span>
        )}
        {c.archived && <span className="flex-none bg-background px-half text-muted-foreground">archived {c.archived}</span>}
      </h3>
      {c.description && <p className={cn("break-words", on ? "whitespace-pre-wrap" : "line-clamp-2")}>{c.description}</p>}
      <dl className="mt-half grid grid-cols-[8ch_1fr] gap-x-ch">
        <Field label="memory">
          {empty ? (
            <span className="text-muted-foreground">empty</span>
          ) : (
            <span>
              {plural(m.notes, "note", "notes")} · {plural(m.entries, "log entry", "log entries")} · {plural(m.episodes, "session", "sessions")}
            </span>
          )}
        </Field>
        {m.last && <Field label="active">{m.last}</Field>}
        <Field label="runs as">{c.account ?? <span className="text-muted-foreground">the machine's default account</span>}</Field>
        {c.credentials.length > 0 && (
          <Field label="holds">
            <Tags items={c.credentials} />
            <span className="text-review">its spawns wait for you</span>
          </Field>
        )}
        {c.abilities.length > 0 && (
          <Field label="can">
            <Tags items={c.abilities} />
          </Field>
        )}
        <Field label="reaches">
          {c.egress.length === 0 ? (
            <span className="text-muted-foreground">only what its machine allows</span>
          ) : (
            <span className={on ? "break-words" : "truncate"}>
              {reach.join("  ")}
              {reach.length < c.egress.length && <span className="text-muted-foreground">  +{c.egress.length - reach.length} more</span>}
            </span>
          )}
        </Field>
      </dl>
      <p className="mt-half flex flex-wrap gap-x-2ch border-t pt-half">
        {c.archived ? (
          <>
            {button("u", "restore", "restore")}
            {button("P", "purge", "purge", true)}
          </>
        ) : (
          <>
            {button("⏎", "memory", "open memory")}
            {button("e", "edit", "edit")}
            {button("d", "archive", "archive")}
          </>
        )}
      </p>
    </section>
  );
}

// A label, dim, and its value.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-x-ch">{children}</dd>
    </>
  );
}

// Words set off as tags.
function Tags({ items }: { items: string[] }) {
  return items.map((t) => (
    <span key={t} className="bg-muted px-half">
      {t}
    </span>
  ));
}

// An action with its key before it, the key lit where it works.
function Button({ k, lit, danger, onClick, children }: { k: string; lit?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn("cursor-pointer px-half hover:bg-accent", !lit && "text-muted-foreground")}
    >
      <span className={cn(lit && (danger ? "text-destructive" : "text-primary"))}>{k}</span> {children}
    </button>
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
            "sessions",
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
