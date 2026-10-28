// The fleet view: each environment and what runs there (the brains' VMs,
// the slots and their spawns, the memory budget), then the spawns. Neovim
// asks the Worker and owns the selection (corkboard.fleet); a click on a
// spawn calls back into it.

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Running = {
  budget: number | null;
  used: number;
  residents: { name: string; brain: string | null; memory: number | null; up: boolean }[];
  slots: { name: string; spawn: string | null; template: string | null; memory: number | null }[];
};
type Environment = { name: string; seen: string; ago: string; stale?: boolean; running?: Running; templates: string[] };
type Spawn = {
  id: string;
  template: string;
  environment: string;
  state: string;
  brain?: string;
  by: string;
  task: string;
  board: string;
  card: string;
  slot?: string;
  ago: string;
  error?: string;
};
type FleetState = { environments: Environment[]; spawns: Spawn[]; selected?: string; problem?: string; loading?: boolean };

const gib = (mib: number | null | undefined) => (mib == null ? "—" : `${(mib / 1024).toFixed(1)} GiB`);

const STATE_CLASS: Record<string, string> = {
  "pending-approval": "text-review",
  queued: "text-muted-foreground",
  running: "text-working",
  done: "text-foreground",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

export function Fleet({ state, win, focused, nvim }: ViewProps<FleetState>) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const spawnsBy = new Map(state.spawns.map((s) => [s.id, s]));

  return (
    <div className="@container/fleet flex h-full flex-col overflow-y-auto px-2ch pt-row">
      <header className="flex justify-between gap-2ch pb-row text-muted-foreground">
        <span className="font-bold text-foreground">Fleet</span>
        <span className="flex-none @max-[70ch]/fleet:hidden">j/k spawn · a approve · x stop · ⏎ card · R refresh</span>
      </header>
      {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
      {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(44ch,1fr))] gap-x-3ch gap-y-row">
        {state.environments.map((e) => (
          <EnvironmentBox key={e.name} e={e} spawns={spawnsBy} onPick={(id) => nvim.lua("require('corkboard.fleet').select(...)", id, win)} />
        ))}
      </div>
      {state.spawns.length > 0 && (
        <section className="mt-row flex min-h-0 flex-col border-t pt-half">
          <h2 className="text-muted-foreground lowercase">Spawns</h2>
          <ol ref={list}>
            {state.spawns.map((s) => {
              const on = s.id === state.selected;
              return (
                <li
                  key={s.id}
                  data-selected={on || undefined}
                  onClick={() => nvim.lua("require('corkboard.fleet').select(...)", s.id, win)}
                  title={`${s.id} · card ${s.card} on ${s.board} · asked by ${s.by}`}
                  className={cn(
                    "cursor-pointer px-ch hover:bg-accent",
                    on && "bg-selection hover:bg-selection",
                    on && focused && "shadow-[inset_0.5ch_0_0_var(--primary)]",
                  )}
                >
                  <div className="grid grid-cols-[17ch_15ch_16ch_8ch_1fr] gap-x-ch @max-[80ch]/fleet:grid-cols-[17ch_15ch_1fr]">
                    <span className={STATE_CLASS[s.state]}>{s.state}</span>
                    <span className="truncate">{s.template}</span>
                    <span className="truncate text-muted-foreground @max-[80ch]/fleet:hidden">
                      {s.environment}
                      {s.slot ? `/${s.slot}` : ""}
                    </span>
                    <span className="text-muted-foreground @max-[80ch]/fleet:hidden">{s.ago}</span>
                    <span className={cn("truncate", on && focused && "font-bold")}>{s.task}</span>
                  </div>
                  {on && s.error && <div className="pl-[18ch] text-destructive whitespace-pre-wrap">{s.error}</div>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

// One environment, boxed: its budget as a bar, then a line per VM.
function EnvironmentBox({ e, spawns, onPick }: { e: Environment; spawns: Map<string, Spawn>; onPick: (id: string) => void }) {
  const r = e.running;
  return (
    <section className={cn("border px-ch pb-half", e.stale && "opacity-60")}>
      <h2 className="-mt-half flex justify-between gap-ch">
        <span className="bg-background px-half font-bold uppercase">{e.name}</span>
        <span className="bg-background px-half text-muted-foreground">{e.stale ? `not heard from since ${e.ago}` : `seen ${e.ago}`}</span>
      </h2>
      {r?.budget != null && <Meter used={r.used} budget={r.budget} />}
      {!r && <p className="text-muted-foreground">its fleetd hasn't said what runs there</p>}
      <ul>
        {r?.residents.map((v) => (
          <li key={v.name} className="grid grid-cols-[2ch_12ch_8ch_1fr] gap-x-ch tabular-nums">
            <span className={v.up ? "text-working" : "text-muted-foreground"}>{v.up ? "●" : "○"}</span>
            <span className={cn("truncate", !v.up && "text-muted-foreground")}>{v.name}</span>
            <span className="truncate text-muted-foreground">{v.brain ?? "—"}</span>
            <span className="text-right text-muted-foreground">{gib(v.memory)}</span>
          </li>
        ))}
        {r?.slots.map((sl) => {
          const s = sl.spawn ? spawns.get(sl.spawn) : undefined;
          return (
            <li
              key={sl.name}
              onClick={() => s && onPick(s.id)}
              title={s ? s.task : undefined}
              className={cn("grid grid-cols-[2ch_12ch_8ch_1fr] gap-x-ch tabular-nums", s && "cursor-pointer hover:bg-accent")}
            >
              <span className={sl.spawn ? "text-working" : "text-muted-foreground"}>{sl.spawn ? "◆" : "◇"}</span>
              <span className={cn("truncate", !sl.spawn && "text-muted-foreground")}>{sl.name}</span>
              <span className="truncate text-muted-foreground">{s?.brain ?? (sl.spawn ? "—" : "")}</span>
              <span className="flex min-w-0 justify-between gap-ch">
                <span className="truncate">{sl.template ?? <span className="text-muted-foreground">free</span>}</span>
                {sl.spawn && <span className="flex-none text-muted-foreground">{gib(sl.memory)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="truncate text-muted-foreground" title={e.templates.join(", ")}>
        runs {e.templates.join(", ") || "nothing"}
      </p>
    </section>
  );
}

// The budget as a row of cells: filled for what's used.
function Meter({ used, budget }: { used: number; budget: number }) {
  const CELLS = 24;
  const filled = Math.min(CELLS, Math.round((used / budget) * CELLS));
  const full = used / budget > 0.9;
  return (
    <p className="flex gap-ch tabular-nums">
      <span className={full ? "text-review" : "text-working"}>
        {"█".repeat(filled)}
        <span className="text-muted-foreground">{"░".repeat(CELLS - filled)}</span>
      </span>
      <span className="text-muted-foreground">
        {gib(used)} / {gib(budget)}
      </span>
    </p>
  );
}
