// The day plan (corkboard.plan): today as a column of blocks with what's
// ranked across projects beside it, and a re-plan of it as a diff. Neovim
// owns the plan, the selection and the keys; clicks and the key hints call
// back into it.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Kind = "work" | "fixed" | "off";
type Project = { key: string; name: string; color: "accent" | "review" | "working" | "special" };
type Block = { id: string; start: number; stop: number; title: string; kind: Kind; project?: string; tag?: string; card?: string; pinned?: boolean };
type Ranked = { title: string; project: string; est: string; why: string; block?: string };
type PlanState = {
  date: string;
  // Why there's no plan to show: no bridge, not signed in, the Worker down.
  problem?: string;
  projects: Project[];
  blocks: Block[];
  selected?: string;
  ranked: Ranked[];
  later?: { title: string; project: string; why: string }[];
  later_count: number;
  inputs: { label: string; value: string; tone?: string }[];
  focus: string;
  fixed: number;
  proposal?: boolean;
};

type Op = " " | "+" | "-" | "~";
type Line = { op: Op; hunk?: number; id: string; start: number; stop: number; title: string; kind: Kind; project?: string; card?: string; was?: string };
type Hunk = { start: number; stop: number; why: string[]; counts: Record<string, number> };
type DiffState = {
  date: string;
  from: string;
  projects: Project[];
  reasons: { tone?: string; text: string; source: string }[];
  lines: Line[];
  hunks: Hunk[];
  counts: Record<string, number>;
  selected: number;
  effects: string[];
  asked: string[];
};

// A theme color's CSS variable, by the names corkboard.theme sends.
const VAR: Record<string, string> = {
  accent: "var(--primary)",
  review: "var(--review)",
  working: "var(--working)",
  special: "var(--special)",
  blocked: "var(--blocked)",
};

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function length(m: number) {
  const h = Math.floor(m / 60), rest = m % 60;
  if (!h) return `${rest}m`;
  return rest ? `${h}h${String(rest).padStart(2, "0")}` : `${h}h`;
}

// The project's color, or undefined for blocks that are no project's.
function colorOf(projects: Project[], key?: string) {
  const p = projects.find((p) => p.key === key);
  return p ? VAR[p.color] : undefined;
}

const pinOf = (kind: Kind) => (kind === "fixed" ? "◇" : kind === "off" ? "·" : "●");

// The time of day in minutes, kept current.
function useNow() {
  const get = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  };
  const [now, setNow] = useState(get);
  useEffect(() => {
    const id = setInterval(() => setNow(get()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// A box with its title set into the top border, like the board's cards.
function Box({ title, aside, className, children }: { title: string; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("relative border pt-half", className)}>
      <h2 className="absolute -top-half left-ch flex gap-ch bg-background px-ch whitespace-nowrap">
        <span className="font-bold">{title}</span>
        {aside && <span className="text-muted-foreground">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

// Key hints along the bottom, as the board has them: each one runs the
// action it names.
function Keys({ keys, onKey }: { keys: string[][]; onKey: (name: string) => void }) {
  return (
    <div className="flex flex-wrap gap-x-3ch border-t py-half @max-[64ch]/plan:gap-x-2ch">
      {keys.map(([name, key, label]) => (
        <Button
          key={name}
          variant="link"
          size="cell"
          title={`${label} (${key})`}
          onClick={() => onKey(name)}
          className="px-0 text-muted-foreground hover:text-foreground hover:no-underline"
        >
          <kbd className="text-primary">{key}</kbd>
          <span className="lowercase @max-[64ch]/plan:hidden">{label}</span>
        </Button>
      ))}
    </div>
  );
}

// The day ----------------------------------------------------------------------

const PLAN_KEYS = [
  ["replan", "r", "Re-plan"],
  ["edit", "e", "Edit"],
  ["pin", "p", "Pin"],
  ["later", "z", "Not today"],
  ["open", "⏎", "Open card"],
  ["reset", "R", "Read again"],
];

// Half an hour is a line of the grid.
const rows = (minutes: number) => `calc(var(--cell-h) * ${minutes / 30})`;

export function Plan({ state, win, focused, nvim }: ViewProps<PlanState>) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow();
  const select = (id: string) => nvim.lua("require('corkboard.plan').select(...)", id, win);
  const action = (name: string) => nvim.lua("require('corkboard.plan').action(...)", "plan", name, win);

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  const lanes = laneOf(state.blocks);
  const linked = state.ranked.findIndex((r) => r.block && r.block === state.selected);

  return (
    <div className="@container/plan flex h-full flex-col px-2ch pt-row">
      <header className="flex flex-wrap justify-between gap-x-2ch pb-row">
        <span>
          today · {state.date}
          <span className="text-muted-foreground"> · {state.focus} planned · {state.fixed} fixed</span>
        </span>
        {state.proposal ? (
          <span className="text-review">● a re-plan is waiting · r to see it</span>
        ) : state.problem ? (
          <span className="text-blocked">● {state.problem}</span>
        ) : !state.blocks.length ? (
          <span className="text-muted-foreground">no plan yet · the assistant proposes one</span>
        ) : null}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(34ch,46ch)] gap-x-3ch @max-[96ch]/plan:grid-cols-1 @max-[96ch]/plan:overflow-y-auto @max-[96ch]/plan:pt-half">
        <Box title="day" aside="00:00 → 24:00" className="flex min-h-0 flex-col @max-[96ch]/plan:min-h-[calc(var(--cell-h)*20)]">
          <div ref={ref} className="min-h-0 flex-1 overflow-y-auto py-half pr-ch">
            <div className="relative" style={{ height: rows(24 * 60) }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="absolute right-0 left-0 flex border-t border-dotted border-[color-mix(in_srgb,var(--border)_60%,transparent)]"
                  style={{ top: rows(h * 60) }}
                >
                  <span className="-mt-half w-[7ch] flex-none bg-background pl-ch text-muted-foreground">{clock(h * 60)}</span>
                </div>
              ))}
              {state.blocks.map((b) => (
                <DayBlock
                  key={b.id}
                  b={b}
                  lane={lanes.get(b.id)!}
                  color={colorOf(state.projects, b.project)}
                  past={b.stop <= now}
                  selected={b.id === state.selected}
                  focused={focused}
                  onClick={() => select(b.id)}
                  onDoubleClick={() => select(b.id).then(() => action("open"))}
                />
              ))}
              {now > 0 && now < 24 * 60 && (
                <div className="pointer-events-none absolute right-0 left-0 z-1 flex items-center" style={{ top: `calc(${rows(now)} - var(--cell-h) / 2)` }}>
                  <span className="bg-blocked px-ch font-bold text-background">{clock(now)}</span>
                  <span className="flex-1 border-t border-blocked" />
                </div>
              )}
            </div>
          </div>
        </Box>

        <aside className="flex min-h-0 flex-col gap-row overflow-y-auto pt-half @max-[96ch]/plan:overflow-visible @max-[96ch]/plan:pt-row">
          <Box title="priority" aside={`${state.projects.length} projects`}>
            <ol className="py-half">
              {state.ranked.map((r, i) => (
                <li
                  key={i}
                  onClick={() => r.block && select(r.block)}
                  className={cn("px-ch", r.block && "cursor-pointer hover:bg-accent", i === linked && "bg-selection hover:bg-selection")}
                >
                  <div className="flex gap-ch">
                    <span className="w-2ch flex-none text-muted-foreground">{i + 1}</span>
                    <span style={{ color: colorOf(state.projects, r.project) }}>●</span>
                    <span className={cn("min-w-0 flex-1 truncate", i === linked && focused && "font-bold")}>{r.title}</span>
                    <span className="flex-none text-muted-foreground">{r.est}</span>
                  </div>
                  <div className="pl-[5ch] text-muted-foreground">{r.why}</div>
                </li>
              ))}
            </ol>
            <div className="border-t px-ch text-muted-foreground">
              {state.later ? (
                <>
                  <div>not today · <kbd className="text-primary">z</kbd> to hide</div>
                  {state.later.map((l, i) => (
                    <div key={i} className="flex gap-ch">
                      <span style={{ color: colorOf(state.projects, l.project) }}>●</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{l.title}</span>
                      <span className="flex-none">{l.why}</span>
                    </div>
                  ))}
                </>
              ) : (
                <>─ not today ({state.later_count}) · <kbd className="text-primary">z</kbd> to show</>
              )}
            </div>
          </Box>

          <Box title="inputs">
            <dl className="grid grid-cols-[12ch_1fr] gap-x-2ch px-ch py-half">
              {state.inputs.map((x) => (
                <div key={x.label} className="contents">
                  <dt className="text-muted-foreground">{x.label}</dt>
                  <dd style={{ color: x.tone ? VAR[x.tone] : undefined }}>{x.value}</dd>
                </div>
              ))}
            </dl>
          </Box>

          <Box title="legend">
            <div className="flex flex-wrap gap-x-2ch px-ch py-half">
              {state.projects.map((p) => (
                <span key={p.key}>
                  <span style={{ color: VAR[p.color] }}>●</span> {p.name}
                </span>
              ))}
              <span>◇ calendar</span>
              <span className="text-muted-foreground">· off</span>
            </div>
          </Box>
        </aside>
      </div>
      <Keys keys={PLAN_KEYS} onKey={action} />
    </div>
  );
}

// Which side-by-side lane each block takes, and how many lanes its group of
// overlapping blocks needs: a re-plan's undone hunk can leave two blocks at
// the same time.
function laneOf(blocks: Block[]) {
  const out = new Map<string, { lane: number; of: number }>();
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let group: Block[] = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const close = () => {
    for (const b of group) out.get(b.id)!.of = ends.length;
    group = [];
    ends = [];
  };
  for (const b of sorted) {
    if (b.start >= groupEnd) close();
    let lane = ends.findIndex((end) => end <= b.start);
    if (lane < 0) lane = ends.push(b.stop) - 1;
    else ends[lane] = b.stop;
    out.set(b.id, { lane, of: 0 });
    group.push(b);
    groupEnd = Math.max(groupEnd, b.stop);
  }
  close();
  return out;
}

function DayBlock({
  b,
  lane,
  color,
  past,
  selected,
  focused,
  ...handlers
}: {
  b: Block;
  lane: { lane: number; of: number };
  color?: string;
  past: boolean;
  selected: boolean;
  focused: boolean;
} & Pick<React.ComponentProps<"div">, "onClick" | "onDoubleClick">) {
  const minutes = b.stop - b.start;
  const tall = minutes >= 60;
  const style: React.CSSProperties = {
    top: rows(b.start),
    height: `calc(${rows(minutes)} - 2px)`,
    left: `calc(8ch + (100% - 8ch) * ${lane.lane / lane.of})`,
    width: `calc((100% - 8ch) / ${lane.of} - 2px)`,
  };
  if (b.kind === "work" && color) {
    style.background = `color-mix(in srgb, ${color} 14%, var(--background))`;
    style.borderColor = `color-mix(in srgb, ${color} 60%, var(--background))`;
  }
  return (
    <div
      data-selected={selected || undefined}
      title={`${clock(b.start)}–${clock(b.stop)} · ${b.title}`}
      className={cn(
        "absolute flex cursor-pointer flex-col overflow-hidden border px-ch",
        b.kind === "off" && "border-dotted text-muted-foreground",
        b.kind === "fixed" && "border-dashed border-muted-foreground bg-muted",
        past && "opacity-55",
        selected && "border-muted-foreground bg-selection!",
        selected && focused && "border-primary",
      )}
      style={style}
      {...handlers}
    >
      {/* Half an hour is one line, less the border: the line shrinks to fit. */}
      <div className={cn("flex min-w-0 gap-ch", !tall && "leading-[calc(var(--cell-h)-2px)]")}>
        <span className="flex-none" style={{ color: b.kind === "work" ? color : undefined }}>
          {pinOf(b.kind)}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", selected && focused && "font-bold")}>{b.title}</span>
        {b.tag && <span className="flex-none text-muted-foreground">{b.tag}</span>}
      </div>
      {tall && (
        <div className="truncate pl-2ch text-muted-foreground">
          {clock(b.start)}–{clock(b.stop)} · {length(minutes)}
          {b.card && ` · ${b.card}`}
          {b.pinned && <span className="text-primary"> · pinned</span>}
        </div>
      )}
    </div>
  );
}

// The re-plan ----------------------------------------------------------------------

const DIFF_KEYS = [
  ["accept", "A", "Accept"],
  ["undo", "u", "Undo hunk"],
  ["next", "]h", "Next hunk"],
  ["prev", "[h", "Previous hunk"],
  ["say", "S", "Say what to change"],
  ["open", "⏎", "Open card"],
  ["discard", "q", "Keep old plan"],
];

const OP: Record<Op, { sign: string; className: string; style?: React.CSSProperties }> = {
  " ": { sign: " ", className: "text-muted-foreground" },
  "+": { sign: "+", className: "", style: { background: "color-mix(in srgb, var(--working) 12%, var(--background))" } },
  "-": { sign: "−", className: "line-through decoration-[color-mix(in_srgb,var(--blocked)_60%,transparent)]", style: { background: "color-mix(in srgb, var(--blocked) 12%, var(--background))" } },
  "~": { sign: "~", className: "", style: { background: "color-mix(in srgb, var(--review) 12%, var(--background))" } },
};
const SIGN_COLOR: Record<Op, string> = { " ": "", "+": "text-working", "-": "text-blocked", "~": "text-review" };

export function PlanDiff({ state, win, focused, nvim }: ViewProps<DiffState>) {
  const ref = useRef<HTMLDivElement>(null);
  const action = (name: string) => nvim.lua("require('corkboard.plan').action(...)", "plan-diff", name, win);
  const pick = (i: number) => nvim.lua("require('corkboard.plan').select_hunk(...)", i, win);

  useEffect(() => {
    ref.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  const hunk = state.hunks[state.selected - 1];
  const c = state.counts;

  return (
    <div className="@container/plan flex h-full flex-col px-2ch pt-row">
      <header className="flex flex-wrap justify-between gap-x-2ch pb-row">
        <span>
          re-plan · {state.date} <span className="text-muted-foreground">· from {state.from}</span>
        </span>
        <span className="text-muted-foreground">
          <kbd className="text-primary">A</kbd> writes it to the calendar
        </span>
      </header>

      <Box title="why now" className="mb-row">
        <ul className="px-ch py-half">
          {state.reasons.map((r, i) => (
            <li key={i} className="flex gap-ch">
              {/* A reason with no tone is the calendar's, marked as its events are. */}
              <span style={{ color: r.tone ? VAR[r.tone] : undefined }}>{r.tone ? "●" : "◇"}</span>
              <span className="min-w-0 flex-1">
                {r.text} <span className="text-muted-foreground">({r.source})</span>
              </span>
            </li>
          ))}
        </ul>
      </Box>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(32ch,44ch)] gap-x-3ch @max-[96ch]/plan:grid-cols-1 @max-[96ch]/plan:overflow-y-auto @max-[96ch]/plan:pt-half">
        <Box
          title="diff: rest of today"
          aside={
            <>
              <span className="text-working">+{c["+"]}</span> <span className="text-blocked">−{c["-"]}</span>{" "}
              <span className="text-review">~{c["~"]}</span>
            </>
          }
          className="flex min-h-0 flex-col"
        >
          <div ref={ref} className="min-h-0 flex-1 overflow-y-auto py-half">
            {state.lines.map((l, i) => {
              const head = l.hunk !== undefined && l.hunk !== state.lines[i - 1]?.hunk;
              const on = l.hunk === state.selected;
              const h = l.hunk !== undefined ? state.hunks[l.hunk - 1] : undefined;
              return (
                <div key={`${l.op}${l.id}`}>
                  {head && h && (
                    <div
                      data-selected={on || undefined}
                      onClick={() => pick(l.hunk!)}
                      className={cn("mt-half cursor-pointer px-ch text-primary hover:bg-accent", on && "bg-selection hover:bg-selection", on && focused && "font-bold")}
                    >
                      @@ {clock(h.start)}–{clock(h.stop)} · hunk {l.hunk} of {state.hunks.length} @@
                    </div>
                  )}
                  <div
                    onClick={() => l.hunk !== undefined && pick(l.hunk)}
                    className={cn("flex gap-ch px-ch", l.hunk !== undefined && "cursor-pointer")}
                    style={OP[l.op].style}
                  >
                    <span className={cn("w-ch flex-none font-bold", SIGN_COLOR[l.op])}>{OP[l.op].sign}</span>
                    <span className="w-[11ch] flex-none text-muted-foreground">
                      {clock(l.start)}–{clock(l.stop)}
                    </span>
                    <span className="flex-none" style={{ color: l.kind === "work" ? colorOf(state.projects, l.project) : undefined }}>
                      {pinOf(l.kind)}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", OP[l.op].className)}>{l.title}</span>
                    {l.was && <span className="flex-none text-muted-foreground">was {l.was}</span>}
                  </div>
                </div>
              );
            })}
            {!state.hunks.length && <div className="px-ch text-muted-foreground">No changes left. q keeps the plan as it is.</div>}
          </div>
        </Box>

        <aside className="flex min-h-0 flex-col gap-row overflow-y-auto pt-half @max-[96ch]/plan:overflow-visible @max-[96ch]/plan:pt-row">
          {hunk && (
            <Box title={`hunk ${state.selected} of ${state.hunks.length}`} aside={`${clock(hunk.start)}–${clock(hunk.stop)}`}>
              <ul className="flex flex-col gap-half px-ch py-half">
                {hunk.why.map((w, i) => (
                  <li key={i} className="flex gap-ch">
                    <span className="text-muted-foreground">·</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </Box>
          )}
          <Box title="on accept">
            <ul className="px-ch py-half">
              {state.effects.map((e, i) => (
                <li key={i} className={cn(i > 0 && "text-muted-foreground")}>
                  {e}
                </li>
              ))}
            </ul>
          </Box>
          <Box title="you asked">
            <div className="px-ch py-half">
              {state.asked.length ? (
                state.asked.map((a, i) => (
                  <div key={i} className="flex gap-ch">
                    <span className="text-primary">›</span>
                    <span>{a}</span>
                  </div>
                ))
              ) : (
                <span className="text-muted-foreground">
                  <kbd className="text-primary">S</kbd> to say what to change
                </span>
              )}
              {state.asked.length > 0 && <div className="text-muted-foreground">for the assistant's next re-plan</div>}
            </div>
          </Box>
        </aside>
      </div>
      <Keys keys={DIFF_KEYS} onKey={action} />
    </div>
  );
}
