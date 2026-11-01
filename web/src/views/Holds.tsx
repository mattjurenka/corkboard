// What brains hold: the spawns waiting on you because of a hold, boxed at the
// top with their task, then a card per hold, its mark and name on the border,
// what it's for, its secret, where it's kept and who holds it, and what you
// can do with it along its foot. Drawn over agent://holds (corkboard.holds),
// which owns the cursor and the keys; a click selects, a button acts, and a
// double click edits the hold or opens the task, in Neovim.

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import { Button, Field, Tags } from "./Brains";
import type { ViewProps } from "./index";

type Wait = { key: string; id: string; brain?: string; by: string; template: string; environment: string; task: string; ago?: string; holds: string[] };
type Hold = {
  key: string;
  name: string;
  about?: string;
  where?: string;
  secret?: string;
  recorded: boolean;
  brains: string[];
  templates: string[];
  mark: "●" | "◌" | "○";
};
type HoldsState = {
  buf: number;
  waiting: Wait[];
  holds: Hold[];
  selected?: string;
  asking?: { name: string; what: "delete" | "forget" };
  problem?: string;
  loading?: boolean;
};
type Act = "open" | "edit" | "delete" | "forget" | "approve" | "deny";

const MARK = { "●": "text-working", "◌": "text-review", "○": "text-muted-foreground" };

export function Holds({ state, win, focused, nvim }: ViewProps<HoldsState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const act = (key: string, what?: Act) => nvim.lua("require('corkboard.holds').select(...)", key, win, what ?? null);
  const make = () => nvim.lua("require('corkboard.holds').new()");
  const waiting = state.waiting ?? [];
  const holds = state.holds ?? [];

  return (
    <div className="relative h-full">
      <div ref={root} className="flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
        <header className="flex items-baseline justify-between gap-2ch">
          <span className="font-bold">Holds</span>
          <Button k="a" lit onClick={make}>
            new hold
          </Button>
        </header>
        {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
        {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
        {waiting.length > 0 && (
          <section className="flex flex-col border border-review px-ch pb-half">
            <h2 className="-mt-half flex">
              <span className="bg-background px-half font-bold text-review">waiting on you</span>
            </h2>
            {waiting.map((w) => (
              <WaitRow key={w.key} wait={w} on={w.key === state.selected} focused={focused} onAct={act} />
            ))}
          </section>
        )}
        {!state.loading && !state.problem && holds.length === 0 && <p className="px-ch text-muted-foreground">No holds.</p>}
        {holds.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(44ch,1fr))] items-start gap-x-2ch gap-y-row">
            {holds.map((h) => (
              <HoldCard key={h.key} hold={h} on={h.key === state.selected} focused={focused} onAct={act} />
            ))}
          </div>
        )}
      </div>
      {state.asking && <Ask {...state.asking} onAnswer={(yes) => nvim.lua("require('corkboard.holds').answer(...)", yes)} />}
    </div>
  );
}

// A spawn an agent asked for, held until you say: who asked, for what, the
// holds that hold it, and its task.
function WaitRow({ wait: w, on, focused, onAct }: { wait: Wait; on: boolean; focused: boolean; onAct: (key: string, what?: Act) => void }) {
  return (
    <div
      data-selected={on || undefined}
      onClick={() => onAct(w.key)}
      onDoubleClick={() => onAct(w.key, "open")}
      className={cn("flex cursor-pointer flex-col py-half not-first:border-t", on && (focused ? "bg-primary/20" : "bg-accent"))}
    >
      <p className="flex flex-wrap justify-between gap-x-2ch">
        <span>
          <span className="font-bold">{w.by}</span> <span className="text-muted-foreground">wants</span> <span className="font-bold">{w.brain ?? w.template}</span>
          {w.brain && <span className="text-muted-foreground"> on {w.template}</span>}
          <span className="text-muted-foreground"> in {w.environment}</span>
        </span>
        {w.ago && <span className="text-muted-foreground">{w.ago}</span>}
      </p>
      {w.holds.length > 0 && (
        <dl className="grid grid-cols-[8ch_1fr] gap-x-ch">
          <Field label="holds">
            <Tags items={w.holds} />
          </Field>
        </dl>
      )}
      <p className={cn("border-l-2 border-review pl-ch break-words whitespace-pre-wrap", !on && "line-clamp-3")}>{w.task}</p>
      <p className="mt-half flex flex-wrap gap-x-2ch">
        <Button k="A" lit={on} onClick={() => onAct(w.key, "approve")}>
          approve
        </Button>
        <Button k="x" lit={on} danger onClick={() => onAct(w.key, "deny")}>
          deny
        </Button>
        <Button k="⏎" lit={on} onClick={() => onAct(w.key, "open")}>
          task
        </Button>
      </p>
    </div>
  );
}

function HoldCard({ hold: h, on, focused, onAct }: { hold: Hold; on: boolean; focused: boolean; onAct: (key: string, what?: Act) => void }) {
  const button = (k: string, what: Act, label: string, danger?: boolean) => (
    <Button k={k} lit={on} danger={danger} onClick={() => onAct(h.key, what)}>
      {label}
    </Button>
  );
  return (
    <section
      data-selected={on || undefined}
      onClick={() => onAct(h.key)}
      onDoubleClick={() => onAct(h.key, "edit")}
      className={cn("flex min-w-0 cursor-pointer flex-col border px-ch pb-half", on && "border-primary", h.mark === "○" && "opacity-60")}
    >
      <h3 className="-mt-half flex justify-between gap-ch">
        <span className={cn("truncate bg-background px-half", on && focused && "text-primary")}>
          <span className={MARK[h.mark]}>{h.mark}</span> <span className="font-bold">{h.name}</span>
        </span>
        {!h.recorded && <span className="flex-none bg-background px-half text-muted-foreground">no record</span>}
      </h3>
      {h.about && <p className={cn("break-words", on ? "whitespace-pre-wrap" : "line-clamp-2")}>{h.about}</p>}
      <dl className="mt-half grid grid-cols-[8ch_1fr] gap-x-ch">
        <Field label="secret">{h.secret ? <span>set {h.secret}</span> : <span className="text-muted-foreground">none here</span>}</Field>
        {h.where && <Field label="where">{h.where}</Field>}
        <Field label="held by">
          {h.brains.length + h.templates.length === 0 && <span className="text-muted-foreground">nothing</span>}
          <Tags items={h.brains} />
          {h.templates.map((t) => (
            <span key={t} className="bg-muted px-half">
              {t} <span className="text-special">nix</span>
            </span>
          ))}
        </Field>
      </dl>
      <p className="mt-half flex flex-wrap gap-x-2ch border-t pt-half">
        {button("e", "edit", "edit")}
        {h.secret && button("S", "forget", "forget secret", true)}
        {h.templates.length === 0 && button("d", "delete", "delete", true)}
      </p>
    </section>
  );
}

// d's or S's question, boxed in the middle of the view; y or n answer it there too.
function Ask({ name, what, onAnswer }: { name: string; what: "delete" | "forget"; onAnswer: (yes: boolean) => void }) {
  return (
    <div className="absolute inset-0 z-2 flex items-center justify-center bg-background/60">
      <section className="max-w-[min(60ch,calc(100%-4ch))] border border-destructive bg-background px-2ch pb-half">
        <h2 className="-mt-half flex">
          <span className="bg-background px-half font-bold text-destructive">{what}</span>
        </h2>
        <p className="break-words">{what === "delete" ? `Delete ${name}, its secret, and it off every brain?` : `Forget ${name}'s secret?`}</p>
        <p className="mt-row flex justify-end gap-2ch">
          <button type="button" onClick={() => onAnswer(true)} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-destructive">y</span> yes
          </button>
          <button type="button" onClick={() => onAnswer(false)} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">n</span> no
          </button>
        </p>
      </section>
    </div>
  );
}
