// The token-usage view. Neovim reads the session logs and owns the
// selection (corkboard.usage); a click on a session calls back into it.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Tokens = { input: number; write: number; read: number; output: number; thinking: number };
type Miss = { request: number; label: string; idle_text?: string; ttl?: string; tokens: number; written: number; uncached: number; cost: number };
type Session = {
  id: string;
  title: string;
  ago: string;
  cost?: number;
  session_cost?: number;
  tokens: Tokens;
  requests: number;
  model?: string;
  context: number;
  series: number[];
  miss_points?: number[];
  cache: { hit: number; read: number; write: number; write_1h: number; uncached: number; misses: Miss[]; miss_tokens: number };
  categories?: { label: string; share: number; output?: boolean; written: number; uncached: number; read: number; cost?: number; count: number }[];
  top: { label: string; kind: string; size: number; reads: number; share: number; cost?: number }[];
  agents: { type: string; description: string; requests: number; tokens: Tokens; cost: number }[];
};
type UsageState = {
  root?: string;
  sessions: Session[];
  selected?: string;
  period: string;
  periods?: { key: string; label: string }[];
  sort: string;
  total?: number;
  // Neovim is still reading the session logs for the first time.
  loading?: boolean;
  // What the agents corkboard started cost, per card and per label
  // (corkboard.usage's by_card), all time.
  cards?: { id: string; title: string; cost?: number; tokens: number; sessions: number }[];
  labels?: { label: string; cost: number; cards: number }[];
};

export function Usage({ state, win, focused, nvim }: ViewProps<UsageState>) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const selected = state.sessions.find((s) => s.id === state.selected && s.categories);
  const n = state.sessions.length;

  return (
    <div className="@container/usage flex h-full flex-col px-2ch pt-row">
      <header className="flex justify-between gap-2ch pb-row text-muted-foreground">
        <span className="min-w-0 truncate">{state.root ?? ""}</span>
        <span className="flex-none @max-[80ch]/usage:hidden">j/k session · p period · s sort · R refresh</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(28ch,36ch)_1fr] gap-3ch @max-[80ch]/usage:grid-cols-1 @max-[80ch]/usage:grid-rows-[minmax(0,2fr)_minmax(0,3fr)] @max-[80ch]/usage:gap-y-row">
        <div className="flex min-h-0 flex-col gap-row">
          <div className="flex flex-wrap items-center gap-x-2ch">
            <Segmented
              options={(state.periods ?? []).map((p) => [p.key, p.label])}
              value={state.period}
              onPick={(key) => nvim.lua("require('corkboard.usage').set_period(...)", key)}
            />
            <Segmented
              options={[["recent", "Recent"], ["cost", "Cost"]]}
              value={state.sort}
              onPick={(key) => nvim.lua("require('corkboard.usage').set_sort(...)", key)}
            />
            <span className="text-muted-foreground tabular-nums">
              {n} session{n === 1 ? "" : "s"} · {money(state.total)}
            </span>
          </div>
          <div ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t">
            {state.sessions.map((s) => {
              const on = s.id === state.selected;
              return (
                <article
                  key={s.id}
                  data-selected={on || undefined}
                  onClick={() => nvim.lua("require('corkboard.usage').select(...)", s.id, win)}
                  className={cn(
                    "cursor-pointer border-b px-ch py-half hover:bg-accent",
                    on && "bg-selection hover:bg-selection",
                    on && focused && "shadow-[inset_0.5ch_0_0_var(--primary)]",
                  )}
                >
                  <div className={cn("truncate", on && focused && "font-bold")}>{s.title}</div>
                  <div className="flex gap-2ch text-muted-foreground">
                    <span>{s.ago}</span>
                    <span>{money(s.session_cost ?? s.cost)}</span>
                    <span>{tokens(total(s.tokens))}</span>
                  </div>
                </article>
              );
            })}
            {!n && state.loading && <Spinner className="flex-1" />}
            {!n && !state.loading && (
              <div className="px-ch text-muted-foreground">
                {state.period === "all" ? "No Claude Code sessions in this project yet." : "No sessions in this period."}
              </div>
            )}
          </div>
          {!!state.cards?.length && <ByCard cards={state.cards} labels={state.labels ?? []} />}
        </div>
        {selected ? <Detail s={selected} /> : <div className="px-ch text-muted-foreground">—</div>}
      </div>
    </div>
  );
}

function ByCard({ cards, labels }: { cards: NonNullable<UsageState["cards"]>; labels: NonNullable<UsageState["labels"]> }) {
  return (
    <section className="flex max-h-[40%] min-h-[calc(var(--cell-h)*4)] flex-none flex-col border-t pt-half">
      <h2 className="text-muted-foreground lowercase">By card · all time</h2>
      <ol className="min-h-row flex-1 overflow-y-auto">
        {cards.map((c) => (
          <li key={c.id} title={`${c.id} ${c.title}`} className="flex gap-ch px-ch tabular-nums">
            <span className="flex-none text-muted-foreground">{c.id.replace(/^TASK-/, "#")}</span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="flex-none">{money(c.cost)}</span>
            <span className="flex-none text-muted-foreground">×{c.sessions}</span>
          </li>
        ))}
      </ol>
      {labels.length > 0 && (
        <p className="px-ch text-muted-foreground">
          {labels.map((l, i) => (
            <span key={l.label}>
              {i > 0 && " · "}
              {l.label} <span className="text-foreground tabular-nums">{money(l.cost)}</span>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function Detail({ s }: { s: Session }) {
  const t = s.tokens;
  const c = s.cache;
  const writes = c.write_1h === c.write ? "1h" : c.write_1h ? `${tokens(c.write_1h)} 1h` : "5m";
  return (
    <div className="min-w-0 overflow-y-auto pr-ch">
      <h1 className="mb-row font-bold">{s.title}</h1>
      <div className="mt-half grid grid-cols-[repeat(auto-fit,minmax(18ch,1fr))] gap-x-2ch gap-y-half">
        <Tile label="Cost" value={money(s.session_cost)} sub={s.agents.length ? `incl. ${s.agents.length} subagent${s.agents.length > 1 ? "s" : ""}` : ""} />
        <Tile label="Tokens" value={tokens(total(t))} sub={`output ${tokens(t.output)} · thinking ${tokens(t.thinking)}`} />
        <Tile
          label="Input cached"
          value={pct(c.hit)}
          sub={c.misses.length ? `${c.misses.length} miss${c.misses.length > 1 ? "es" : ""} · ${tokens(c.miss_tokens)} re-sent` : "no misses"}
        />
        <Tile label="Requests" value={String(s.requests)} sub={modelName(s.model)} />
        <Tile label="Context now" value={tokens(s.context)} sub="" />
      </div>
      {/* How the session's input tokens arrived, as a line of text: three
          numbers read better than a three-segment bar where one is 99%. */}
      <p className="mt-half text-muted-foreground">
        <b className="text-foreground">{tokens(c.read)}</b> read from cache · <b className="text-foreground">{tokens(c.write)}</b> written
        to cache ({writes}) · <b className="text-foreground">{tokens(c.uncached)}</b> uncached
      </p>
      {s.series.length > 1 && (
        <Part title="Context size per request">
          <ContextChart series={s.series} missPoints={s.miss_points} />
        </Part>
      )}
      <Part title="Where it went">
        <Categories cats={s.categories!} />
      </Part>
      {c.misses.length > 0 && (
        <Part title="Cache misses">
          <Grid
            head={["request", "cause", "re-sent", "written", "uncached", "cost"]}
            minor={[3, 4]}
            wide={1}
            rows={c.misses.map((m) => ({
              cells: [
                `#${m.request}`,
                m.idle_text && m.label.includes("expired") ? `idle ${m.idle_text}, ${m.ttl ?? "?"} cache expired` : "evicted or prefix changed",
                tokens(m.tokens),
                tokens(m.written),
                tokens(m.uncached),
                money(m.cost),
              ],
            }))}
          />
        </Part>
      )}
      <Part title="Heaviest items">
        <Grid
          head={["item", "size", "reads", "share", "cost"]}
          minor={[2]}
          clip={2}
          rows={s.top.map((it) => ({
            title: `${it.kind}: ${tokens(it.size)} tokens, read by ${it.reads} later requests`,
            cells: [it.label, tokens(it.size), `×${it.reads}`, pct(it.share), it.cost == null ? "" : money(it.cost)],
          }))}
        />
      </Part>
      {s.agents.length > 0 && (
        <Part title="Subagents">
          <Grid
            head={["agent", "task", "requests", "tokens", "cost"]}
            minor={[2]}
            clip={2}
            rows={s.agents.map((a) => ({ cells: [a.type, a.description, String(a.requests), tokens(total(a.tokens)), money(a.cost)] }))}
          />
        </Part>
      )}
    </div>
  );
}

// One bar per category, its share of the session's cost. Written and
// uncached are how its tokens first arrived; cache read is what later
// requests read back of it.
function Categories({ cats }: { cats: NonNullable<Session["categories"]> }) {
  const max = Math.max(...cats.map((c) => c.share), 0.0001);
  return (
    <div>
      <Grid
        head={["", "", "share", "written", "uncached", "cache read", "cost"]}
        minor={[3, 4, 5]}
        barColumn
        rows={cats.map((c) => ({
          title: `${c.label}: ${c.count}× · ${tokens(c.written)} written to cache, ${tokens(c.uncached)} sent uncached · read back ${tokens(c.read)} from cache`,
          cells: [
            c.label,
            <div className="h-half">
              <div
                className={cn("h-full min-w-px bg-primary", c.output && "bg-[color-mix(in_srgb,var(--primary)_45%,var(--background))]")}
                style={{ width: `${(c.share / max) * 100}%` }}
              />
            </div>,
            pct(c.share),
            tokens(c.written),
            tokens(c.uncached),
            tokens(c.read),
            c.cost == null ? "" : money(c.cost),
          ],
        }))}
      />
      <p className="mt-half text-muted-foreground">Shaded bars are Claude's own output; the rest is what was put in front of it.</p>
    </div>
  );
}

// A table on the grid: one line per row, numbers right-aligned, the first
// column left. `clip` columns from the start share the slack and truncate;
// `wide` is a left-aligned column that takes half; `barColumn` puts a bar
// in the second column; `minor` columns are left out when the view is
// narrow.
function Grid({
  head,
  rows,
  clip = 0,
  wide,
  barColumn,
  minor = [],
}: {
  head: string[];
  rows: { title?: string; cells: React.ReactNode[] }[];
  clip?: number;
  wide?: number;
  barColumn?: boolean;
  minor?: number[];
}) {
  const align = (i: number) =>
    cn(
      "h-row px-ch text-right tabular-nums",
      i === 0 && "pl-0 text-left",
      i < clip && "w-[45%] max-w-0 truncate",
      i === wide && "w-1/2 text-left",
      barColumn && i === 1 && "w-2/5",
      minor.includes(i) && "@max-[80ch]/usage:hidden",
    );
  return (
    <Table>
      <TableHeader className="[&_tr]:border-0">
        <TableRow className="border-0 hover:bg-transparent">
          {head.map((h, i) => (
            <TableHead key={i} className={cn(align(i), "font-normal text-muted-foreground")}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i} title={r.title} className="border-0 hover:bg-accent">
            {r.cells.map((cell, j) => (
              <TableCell key={j} className={cn(align(j), "py-0")}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Context size per request as a line, with a crosshair and readout on hover.
// Cache misses are marked with a tick at the top; drops are compactions.
function ContextChart({ series, missPoints = [] }: { series: number[]; missPoints?: number[] }) {
  const [at, setAt] = useState<number | null>(null);
  const W = 600, H = 90, pad = 4;
  const max = Math.max(...series);
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const misses = new Set(missPoints);
  const stroke = { vectorEffect: "non-scaling-stroke" } as const;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Context size, peaking at ${tokens(max)} tokens`}
        className="block h-[calc(var(--cell-h)*5)] w-full"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - box.left) / box.width) * (series.length - 1));
          setAt(Math.max(0, Math.min(series.length - 1, i)));
        }}
        onMouseLeave={() => setAt(null)}
      >
        <polygon points={`${x(0)},${H - pad} ${pts} ${x(series.length - 1)},${H - pad}`} fill="color-mix(in srgb, var(--primary) 15%, transparent)" />
        <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth={2} style={stroke} />
        {at != null && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--muted-foreground)" strokeWidth={1} style={stroke} />}
        {[...misses].map((i) => (
          <line key={i} x1={x(i)} x2={x(i)} y1={0} y2={H - pad} stroke="var(--blocked)" strokeWidth={2} strokeDasharray="3 3" style={stroke} />
        ))}
      </svg>
      <div className="text-right text-muted-foreground">
        {at == null
          ? `peak ${tokens(max)}`
          : `point ${at + 1} of ${series.length}: ${tokens(series[at])}${misses.has(at) ? " · cache miss" : ""}`}
      </div>
    </div>
  );
}

// A row of buttons, one per [key, label], with the current one pressed.
function Segmented({ options, value, onPick }: { options: string[][]; value: string; onPick: (key: string) => void }) {
  return (
    <ToggleGroup
      type="single"
      size="cell"
      value={value}
      // Pressing the current one again would clear it; it stays.
      onValueChange={(key) => key && key !== value && onPick(key)}
    >
      {options.map(([key, label]) => (
        <ToggleGroupItem
          key={key}
          value={key}
          className="text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="gap-0 px-ch pt-half pb-[calc(var(--cell-h)/2-1px)]">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-bold">{value}</div>
      <div className="min-h-row text-muted-foreground">{sub}</div>
    </Card>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mt-row text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

const total = (t: Tokens) => t.input + t.write + t.read + t.output;

function tokens(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n ?? 0));
}

const money = (n?: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);

const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

function modelName(id?: string) {
  const m = /^claude-(\w+)-(\d+)(?:-(\d))?/.exec(id ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}` : (id ?? "");
}
