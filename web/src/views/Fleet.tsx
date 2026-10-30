// The fleet view: each environment with its memory budget and a card per
// machine that's up, each card listing the sessions there, the selected one
// opened up to show its particulars; or, grouped by project, a card per
// project; then the selected machine, and the queue (spawns waiting or
// over) at the foot. Neovim asks the
// Worker and the bridge, groups it and owns the selection (corkboard.fleet);
// a click on a row or a machine calls back into it.

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

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
// A session on a card, or the spawn in a slot. where: the machine, on a
// project's card. detail: what it's asking; context, in tokens; info: the
// rest of what shows under it while it's selected.
type Row = {
  id: string;
  spawn?: boolean;
  state: string;
  title: string;
  project?: string;
  where?: string;
  ago: string;
  detail?: string;
  card?: string;
  machine?: string;
  context?: { used: number; limit: number };
  info?: { label: string; value: string }[];
};
// id: a machine's, which selects it; a project's card has none. summary:
// its config in a line.
type Card = { id?: string; name: string; label?: string; memory?: string; summary?: string; rows: Row[] };
type Host = {
  os?: string;
  kernel?: string;
  cpu?: string;
  cores?: number;
  memory?: number;
  available?: number;
  load?: number[];
  up?: string;
  environment?: string;
  sessions: number;
  vms: number;
};
type Vm = {
  kind?: string;
  capabilities: string[];
  account?: string;
  memory?: number;
  cores?: number;
  address?: string;
  egress?: string;
  domains: string[];
  routed: { reason: string; to: string[]; ports: string[] }[];
  approval?: boolean;
};
// A machine's, or a VM's.
type Detail = { name: string; host?: Host; vm?: Vm };
// budget: the agents' memory budget, or with ram, the machine's memory.
type Group = { name?: string; ago?: string; stale?: boolean; budget?: number; used?: number; ram?: boolean; idle?: string[]; silent?: boolean; cards: Card[] };
// asking: x's "stop it?", until y or n.
type FleetState = { by: "machine" | "project"; queue: Spawn[]; asking?: { id: string; task: string }; groups: Group[]; selected?: string; detail?: Detail; problem?: string; loading?: boolean };

const gib = (mib: number | null | undefined) => (mib == null ? "—" : `${(mib / 1024).toFixed(1)} GiB`);

const STATE_CLASS: Record<string, string> = {
  "pending-approval": "text-review",
  queued: "text-muted-foreground",
  running: "text-working",
  done: "text-foreground",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
  working: "text-working",
  attached: "text-working",
  asking: "text-review",
  permission: "text-review",
  idle: "text-muted-foreground",
};

export function Fleet({ state, win, focused, nvim }: ViewProps<FleetState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (id: string) => nvim.lua("require('corkboard.fleet').select(...)", id, win);
  const groups = state.groups ?? [];

  return (
    <div className="relative h-full">
      <div ref={root} className="@container/fleet flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
        <header className="flex justify-between gap-2ch text-muted-foreground">
          <span className="font-bold text-foreground">Fleet</span>
          <span className="flex-none @max-[70ch]/fleet:hidden">
            j/k · h/l card · a approve · x stop · ⏎ open · g by {state.by === "project" ? "machine" : "project"} · R refresh
          </span>
        </header>
        {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
        {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
        {groups.map((g, i) => (
          <section key={g.name ?? i} className={cn("flex flex-col gap-row", g.stale && "opacity-60")}>
            {g.name && (
              <h2 className="flex flex-wrap items-baseline gap-x-2ch">
                <span className="font-bold uppercase">{g.name}</span>
                {g.budget != null && g.used != null && <Meter used={g.used} budget={g.budget} ram={g.ram} />}
                <span className="text-muted-foreground">
                  {[g.ago && (g.stale ? `not heard from since ${g.ago}` : `seen ${g.ago}`), ...(g.idle ?? [])].filter(Boolean).join(" · ")}
                </span>
              </h2>
            )}
            {g.silent && <p className="text-muted-foreground">its fleetd hasn't said what runs there</p>}
            {g.name && !g.silent && g.cards.length === 0 && <p className="text-muted-foreground">nothing running</p>}
            {g.cards.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(34ch,1fr))] items-start gap-x-2ch gap-y-row">
                {g.cards.map((c) => (
                  <MachineCard key={c.name} card={c} selected={state.selected} focused={focused} onPick={pick} />
                ))}
              </div>
            )}
          </section>
        ))}
        {state.detail && <DetailPane detail={state.detail} />}
        {state.queue?.length > 0 && (
          <ol className={cn("border-t pt-half", !state.detail && "mt-auto")}>
            {state.queue.map((s) => {
              const on = s.id === state.selected;
              return (
                <li
                  key={s.id}
                  data-selected={on || undefined}
                  onClick={() => pick(s.id)}
                  title={`${s.id} · card ${s.card} on ${s.board} · asked by ${s.by}`}
                  className={cn(
                    "cursor-pointer px-ch hover:bg-accent",
                    on && "bg-selection hover:bg-selection",
                    on && focused && "shadow-[inset_0.5ch_0_0_var(--primary)]",
                  )}
                >
                  <div className="grid grid-cols-[17ch_14ch_10ch_1fr_8ch] gap-x-ch @max-[80ch]/fleet:grid-cols-[17ch_1fr]">
                    <span className={STATE_CLASS[s.state]}>{s.state}</span>
                    <span className="truncate @max-[80ch]/fleet:hidden">{s.template}</span>
                    <span className="truncate text-muted-foreground @max-[80ch]/fleet:hidden">{s.environment}</span>
                    <span className={cn("truncate", on && focused && "font-bold")}>{s.task}</span>
                    <span className="text-right text-muted-foreground @max-[80ch]/fleet:hidden">{s.ago}</span>
                  </div>
                  {on && s.error && <div className="pl-[18ch] text-destructive whitespace-pre-wrap">{s.error}</div>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {state.asking && (
        <Ask task={state.asking.task} onAnswer={(yes) => nvim.lua("require('corkboard.fleet').answer(...)", yes)} />
      )}
    </div>
  );
}

// x's question, boxed in the middle of the view; y or n answer it there too.
function Ask({ task, onAnswer }: { task: string; onAnswer: (yes: boolean) => void }) {
  return (
    <div className="absolute inset-0 z-2 flex items-center justify-center bg-background/60">
      <section className="max-w-[min(60ch,calc(100%-4ch))] border border-primary bg-background px-2ch pb-half">
        <h2 className="-mt-half flex">
          <span className="bg-background px-half font-bold text-primary">stop</span>
        </h2>
        <p className="line-clamp-3 break-words">Are you sure you want to stop {task}?</p>
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

// The selected machine, boxed with its name on the border like a card: a
// host as gauges, a VM as what it may reach.
function DetailPane({ detail }: { detail: Detail }) {
  return (
    <section className="mt-auto border px-ch pb-half">
      <h2 className="-mt-half flex">
        <span className="truncate bg-background px-half font-bold">{detail.name}</span>
      </h2>
      {detail.host && <HostDetail host={detail.host} />}
      {detail.vm && <VmDetail vm={detail.vm} />}
    </section>
  );
}

function HostDetail({ host: h }: { host: Host }) {
  const about = [h.os, h.kernel && `linux ${h.kernel}`, h.up && `up ${h.up}`, h.environment].filter(Boolean).join(" · ");
  const cpu = [h.cpu, h.cores != null && `${h.cores} threads`].filter(Boolean).join(" · ");
  const load = h.load?.length ? h.load : undefined;
  return (
    <div className="flex flex-col">
      {about && <p className="truncate text-muted-foreground">{about}</p>}
      {cpu && <p className="truncate">{cpu}</p>}
      <div className="mt-half grid grid-cols-[5ch_auto_1fr] items-baseline gap-x-ch tabular-nums">
        {h.memory != null && (
          <>
            <span className="text-muted-foreground">mem</span>
            <Bar frac={h.available != null ? (h.memory - h.available) / h.memory : 0} cells={24} />
            <span className="truncate text-muted-foreground">
              {h.available != null ? `${gib(h.memory - h.available)} / ${gib(h.memory)}` : gib(h.memory)}
            </span>
          </>
        )}
        {load && (
          <>
            <span className="text-muted-foreground">load</span>
            <Bar frac={h.cores ? load[0] / h.cores : 0} cells={24} />
            <span className="truncate text-muted-foreground">
              {load.map((n) => n.toFixed(2)).join("  ")}
            </span>
          </>
        )}
      </div>
      <p className="mt-half">
        <span className="font-bold">{h.sessions}</span>
        <span className="text-muted-foreground"> {h.sessions === 1 ? "session" : "sessions"} · </span>
        <span className="font-bold">{h.vms}</span>
        <span className="text-muted-foreground"> {h.vms === 1 ? "vm" : "vms"} up</span>
      </p>
    </div>
  );
}

function VmDetail({ vm }: { vm: Vm }) {
  const spec = [vm.cores != null && `${vm.cores} cores`, vm.memory != null && gib(vm.memory), vm.address, vm.account].filter(Boolean);
  return (
    <div className="flex flex-col gap-half">
      <p className="truncate">
        {vm.kind && <span className="font-bold">{vm.kind}</span>}
        {vm.kind && spec.length > 0 && " · "}
        <span className="text-muted-foreground">{spec.join(" · ")}</span>
        {vm.approval && <span className="text-review"> · spawns wait for approval</span>}
      </p>
      {vm.capabilities.length > 0 && <Tags items={vm.capabilities} />}
      <div className="grid grid-cols-[2ch_1fr] gap-x-ch">
        <span className={vm.egress === "open" ? "text-review" : "text-working"}>{vm.egress === "open" ? "◇" : "◆"}</span>
        <div className="flex min-w-0 flex-col">
          <span>{vm.egress === "open" ? "open to anywhere" : vm.domains.length > 0 ? "reaches only" : "reaches nothing"}</span>
          {vm.egress !== "open" && vm.domains.length > 0 && <Tags items={vm.domains} />}
        </div>
      </div>
      {vm.routed.map((r, i) => (
        <div key={i} className="grid grid-cols-[2ch_1fr] gap-x-ch">
          <span className="text-working">⇢</span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{r.reason}</span>
            <span className="truncate text-muted-foreground" title={r.to.join(", ")}>
              {r.to.join(", ")}
              {r.ports.length > 0 && `  ${r.ports.join(", ")}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// One machine (or project), boxed with its name on the border, and a
// two-line entry per session.
function MachineCard({ card, selected, focused, onPick }: { card: Card; selected?: string; focused: boolean; onPick: (id: string) => void }) {
  const label = [card.label, card.memory].filter(Boolean).join(" · ");
  const on = card.id != null && card.id === selected;
  return (
    <section className={cn("min-w-0 border px-ch pb-half", on && "border-primary")}>
      <h3
        data-selected={on || undefined}
        onClick={card.id ? () => onPick(card.id!) : undefined}
        className={cn("-mt-half flex justify-between gap-ch", card.id && "cursor-pointer")}
      >
        <span className={cn("truncate bg-background px-half font-bold", on && focused && "text-primary")}>{card.name}</span>
        {label && <span className="flex-none bg-background px-half text-muted-foreground">{label}</span>}
      </h3>
      {card.summary && <p className="truncate text-muted-foreground">{card.summary}</p>}
      {card.rows.length === 0 && <p className="text-muted-foreground">no session</p>}
      <ul>
        {card.rows.map((r) => {
          const on = r.id === selected;
          return (
            <li
              key={r.id}
              data-selected={on || undefined}
              onClick={() => onPick(r.id)}
              className={cn(
                "cursor-pointer hover:bg-accent",
                on && "bg-selection hover:bg-selection",
                on && focused && "shadow-[inset_0.5ch_0_0_var(--primary)]",
              )}
            >
              <div className="grid grid-cols-[2ch_1fr_auto] gap-x-ch">
                <span className={STATE_CLASS[r.state] ?? "text-working"}>{r.state === "idle" ? "○" : "●"}</span>
                <span className={cn("truncate", on && focused && "font-bold")}>{r.title}</span>
                <span className="text-muted-foreground">{r.ago}</span>
              </div>
              <div className="grid grid-cols-[2ch_1fr] gap-x-ch text-muted-foreground">
                <span />
                <span className="truncate">
                  <span className={STATE_CLASS[r.state]}>{r.state}</span>
                  {" · "}
                  {r.where ?? [r.project, r.card].filter(Boolean).join(" · ")}
                </span>
              </div>
              {on && <RowInfo row={r} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A row's particulars, under it while it's selected: what it's asking, how
// full its context is, and the rest as label and value in a run that wraps.
function RowInfo({ row }: { row: Row }) {
  const { detail, context, info = [] } = row;
  if (!detail && !context && info.length === 0) return null;
  return (
    <div className="grid grid-cols-[2ch_1fr] gap-x-ch pb-half">
      <span className="justify-self-center border-l border-muted-foreground/40" />
      <div className="flex min-w-0 flex-col">
        {detail && <p className="line-clamp-3 whitespace-pre-wrap text-review">{detail}</p>}
        {context && (
          <span className="flex gap-ch">
            <Bar frac={context.used / context.limit} cells={12} />
            <span className="text-muted-foreground tabular-nums">
              {kilo(context.used)} / {kilo(context.limit)}
            </span>
          </span>
        )}
        {info.length > 0 && <Facts facts={info} />}
      </div>
    </div>
  );
}

// Labels and values in a run that wraps, a label dim before its value.
function Facts({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <p className="flex flex-wrap gap-x-2ch">
      {facts.map((f) => (
        <span key={f.label} className="min-w-0 truncate">
          <span className="text-muted-foreground">{f.label}</span> {f.value}
        </span>
      ))}
    </p>
  );
}

// Words set off as tags, wrapping.
function Tags({ items, className }: { items: string[]; className?: string }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-ch">
      {items.map((t) => (
        <span key={t} className={cn("truncate bg-muted px-half", className)} title={t}>
          {t}
        </span>
      ))}
    </span>
  );
}

const kilo = (n: number) => `${Math.round(n / 1000)}k`;

// A fraction as a row of cells, amber past nine tenths.
function Bar({ frac, cells }: { frac: number; cells: number }) {
  const filled = Math.max(0, Math.min(cells, Math.round(frac * cells)));
  return (
    <span className={cn("flex-none", frac > 0.9 ? "text-review" : "text-working")}>
      {"█".repeat(filled)}
      <span className="text-muted-foreground">{"░".repeat(cells - filled)}</span>
    </span>
  );
}

// The budget as a row of cells: filled for what's used.
function Meter({ used, budget, ram }: { used: number; budget: number; ram?: boolean }) {
  return (
    <span className="flex gap-ch tabular-nums">
      <Bar frac={used / budget} cells={24} />
      <span className="text-muted-foreground">
        {gib(used)} / {gib(budget)}
        {ram && " RAM"}
      </span>
    </span>
  );
}
