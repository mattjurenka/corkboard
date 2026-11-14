// The Git tab: the forge and its repositories, each with its last CI run;
// its open pull requests with their checks and reviews; and every worktree
// of the projects agents work in, grouped by project, with what's
// uncommitted, ahead, behind and unpushed and who works there. Neovim
// gathers it and owns the selection (corkboard.git); a click selects, a
// double click opens its files: the list on the left, the cursor's file on
// the right.

import { Fragment, useEffect, useRef } from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Worktree = {
  key: string;
  path: string;
  project: string;
  branch: string;
  head: string;
  main: boolean;
  here: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  unpushed: number;
  pr?: number;
  owner?: { kind: "session" | "card"; label: string };
};
type Pr = {
  key: string;
  repo: string;
  number: number;
  title: string;
  head: string;
  base: string;
  mergeable: boolean;
  ago: string;
  checks?: string;
  review?: { verdict: "approve" | "changes"; reviewer: string; current: boolean };
  owner?: string;
};
type Repo = { key: string; name: string; default: string; prs: number; ci?: { status: string; title: string; branch: string; ago: string } };
type Forge = { error?: string; version?: string; user?: string; ms?: number; leader?: string; web?: boolean; repos?: Repo[] };
type Entry = { key: string; name: string; dir: boolean; status?: string };
type Browse = { title: string; ref: string; path: string; file?: string; entries: Entry[]; loading?: boolean; error?: string };
type GitState = { selected?: string; loading: boolean; worktrees: Worktree[]; prs: Pr[]; forge?: Forge; browse?: Browse | null };

const CHECK: Record<string, [string, string]> = {
  success: ["✓", "text-working"],
  failure: ["✗", "text-destructive"],
  error: ["✗", "text-destructive"],
  pending: ["●", "text-review"],
  running: ["●", "text-review"],
  waiting: ["●", "text-review"],
  blocked: ["●", "text-muted-foreground"],
  cancelled: ["–", "text-muted-foreground"],
  skipped: ["–", "text-muted-foreground"],
};

// A box with its title in the top border.
function Box({ title, aside, className, children }: { title: string; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("border px-ch pb-half", className)}>
      <h2 className="-mt-half flex justify-between gap-2ch">
        <span className="bg-background px-half font-bold">{title}</span>
        {aside && <span className="bg-background px-half text-muted-foreground">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Git({ state, win, focused, nvim }: ViewProps<GitState>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (key: string) => key !== state.selected && nvim.lua("require('corkboard.git').select(...)", key, win);
  const go = (key: string) => nvim.lua("require('corkboard.git').action(...)", "go", key);
  const row = (key: string, className: string, children: React.ReactNode, title?: string) => {
    const on = key === state.selected;
    return (
      <div
        key={key}
        data-nav={key}
        data-selected={on || undefined}
        title={title}
        onMouseDown={() => pick(key)}
        onDoubleClick={() => go(key)}
        className={cn(
          "grid cursor-pointer items-baseline gap-x-ch px-ch",
          className,
          on ? "bg-selection" : "hover:bg-accent",
          on && focused && "shadow-[inset_0.5ch_0_0_var(--primary)]",
        )}
      >
        {children}
      </div>
    );
  };

  if (state.browse) {
    const act = (name: string) => () => nvim.lua("require('corkboard.git').action(...)", name);
    const to = (path: string) => nvim.lua("require('corkboard.git').action(...)", "to", path);
    return <Files b={state.browse} row={row} selected={state.selected} focused={focused} up={act("up")} leave={act("leave")} to={to} />;
  }

  const projects: [string, Worktree[]][] = [];
  for (const w of state.worktrees) {
    const last = projects[projects.length - 1];
    if (last?.[0] === w.project) last[1].push(w);
    else projects.push([w.project, [w]]);
  }
  const f = state.forge;

  return (
    <div ref={root} className="@container/git flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
      <header className="flex gap-2ch">
        <span className="font-bold">Git</span>
        {state.loading && <Spinner className="h-row w-2ch" />}
      </header>

      <Box title="Repositories" aside={f?.version && `Forgejo ${f.version}`}>
        {f?.error && <p className="px-ch whitespace-pre-wrap text-destructive">{f.error}</p>}
        {(f?.repos ?? []).map((r) => {
          const [mark, color] = (r.ci && CHECK[r.ci.status]) || [" ", ""];
          return row(
            r.key,
            "grid-cols-[minmax(16ch,32ch)_5ch_2ch_1fr_4ch] @max-[90ch]/git:grid-cols-[1fr_5ch_2ch_4ch]",
            <>
              <span className={cn("truncate", r.key === state.selected && focused && "font-bold")}>{r.name}</span>
              <span className="text-primary tabular-nums">{r.prs > 0 ? `${r.prs} pr` : ""}</span>
              <span className={color} title={r.ci?.status}>
                {mark}
              </span>
              <span className="truncate text-muted-foreground @max-[90ch]/git:hidden">{r.ci && `${r.ci.title} · ${r.ci.branch}`}</span>
              <span className="text-right text-muted-foreground">{r.ci?.ago}</span>
            </>,
          );
        })}
        {f?.version && (
          <p className="mt-half flex flex-wrap gap-x-2ch px-ch">
            <span>
              <span className="text-working">●</span> {f.user}
            </span>
            <span className="text-muted-foreground tabular-nums">{f.ms}ms</span>
            {f.leader && <span className="text-muted-foreground">on {f.leader}</span>}
          </p>
        )}
        {f?.web !== undefined &&
          row(
            "forge.web",
            "grid-cols-[2ch_1fr]",
            <>
              <span className={f.web ? "text-review" : "text-muted-foreground"}>{f.web ? "◇" : "◆"}</span>
              <span>pages via relay {f.web ? "on" : "off"}</span>
            </>,
          )}
      </Box>

      <Box title="Pull requests" aside={state.prs.length || undefined}>
        {state.prs.length === 0 && !state.loading && <p className="px-ch text-muted-foreground">none open</p>}
        {state.prs.map((p) => {
          const [mark, color] = (p.checks && CHECK[p.checks]) || [" ", ""];
          const r = p.review;
          return row(
            p.key,
            "grid-cols-[6ch_2ch_1fr_minmax(0,28ch)_minmax(0,22ch)_4ch] @max-[90ch]/git:grid-cols-[6ch_2ch_1fr_4ch]",
            <>
              <span className="text-primary tabular-nums">#{p.number}</span>
              <span className={color} title={p.checks}>
                {mark}
              </span>
              <span className="flex min-w-0 gap-ch">
                <span className={cn("truncate", p.key === state.selected && focused && "font-bold")}>{p.title}</span>
                {!p.mergeable && <span className="flex-none text-destructive">conflicts</span>}
              </span>
              <span className="truncate text-muted-foreground @max-[90ch]/git:hidden">
                {p.head} → {p.base}
              </span>
              <span
                className={cn(
                  "truncate @max-[90ch]/git:hidden",
                  !r ? "text-muted-foreground" : !r.current ? "text-muted-foreground line-through" : r.verdict === "approve" ? "text-working" : "text-destructive",
                )}
              >
                {r ? `${r.verdict === "approve" ? "✓" : "✗"} ${r.reviewer}` : "unreviewed"}
              </span>
              <span className="text-right text-muted-foreground">{p.ago}</span>
            </>,
            `${p.repo}${p.owner ? ` · ${p.owner}` : ""}`,
          );
        })}
      </Box>

      <Box title="Worktrees" aside={state.worktrees.length || undefined}>
        {projects.map(([project, list]) => (
          <div key={project} className="mt-half flex flex-col">
            <h3 className="px-ch text-muted-foreground">{project}</h3>
            {list.map((w) =>
              row(
                w.key,
                "grid-cols-[2ch_minmax(16ch,32ch)_8ch_1fr_minmax(0,30ch)] @max-[90ch]/git:grid-cols-[2ch_1fr_8ch_14ch]",
                <>
                  <span className={w.here ? "text-primary" : "text-muted-foreground"}>{w.main ? "◆" : w.here ? "●" : "○"}</span>
                  <span className={cn("truncate", w.key === state.selected && focused && "font-bold")}>{w.branch}</span>
                  <span className="text-muted-foreground">{w.head}</span>
                  <span className="flex gap-ch tabular-nums">
                    {w.dirty > 0 && <span className="text-review">±{w.dirty}</span>}
                    {w.ahead > 0 && <span className="text-working">↑{w.ahead}</span>}
                    {w.behind > 0 && <span className="text-muted-foreground">↓{w.behind}</span>}
                    {w.unpushed > 0 && <span className="text-blocked">⇡{w.unpushed}</span>}
                    {w.pr && <span className="text-primary">#{w.pr}</span>}
                  </span>
                  <span className="truncate text-muted-foreground @max-[90ch]/git:hidden">
                    {w.owner && (w.owner.kind === "session" ? "› " : "▪ ") + w.owner.label}
                  </span>
                </>,
                w.path,
              ),
            )}
          </div>
        ))}
      </Box>
    </div>
  );
}

const STATUS_CLASS = (s?: string) => (!s ? "" : s === "??" ? "text-working" : s.includes("D") ? "text-destructive" : "text-review");

// A thing's files, ".." first. The cursor's file is in Neovim's window
// beside this one (corkboard/git.lua's preview).
function Files({ b, row, selected, focused, up, leave, to }: { b: Browse; row: (key: string, className: string, children: React.ReactNode, title?: string) => React.ReactNode; selected?: string; focused: boolean; up: () => void; leave: () => void; to: (path: string) => void }) {
  const dirs = b.path ? b.path.split("/") : [];
  const crumb = (label: string, path: string) => (
    <button type="button" onClick={() => to(path)} className={cn("cursor-pointer hover:text-primary", path === b.path && "font-bold")}>
      {label}
    </button>
  );
  return (
    <div className="@container/git flex h-full flex-col gap-row px-ch pt-row pb-row">
      <header className="flex min-w-0 gap-2ch">
        <button type="button" onClick={leave} className="cursor-pointer font-bold hover:text-primary">
          ‹ Git
        </button>
        <span className="truncate text-muted-foreground">{b.title}</span>
        {b.loading && <Spinner className="h-row w-2ch" />}
      </header>
      <nav className="flex min-w-0 flex-wrap gap-x-ch">
        {crumb("/", "")}
        {dirs.map((d, i) => (
          <Fragment key={dirs.slice(0, i + 1).join("/")}>
            {i > 0 && <span className="text-muted-foreground">/</span>}
            {crumb(d, dirs.slice(0, i + 1).join("/"))}
          </Fragment>
        ))}
        {b.file && (
          <>
            {dirs.length > 0 && <span className="text-muted-foreground">/</span>}
            <span className="truncate text-muted-foreground">{b.file}</span>
          </>
        )}
      </nav>
      <Box title={b.ref} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div onDoubleClick={up} onMouseDown={(e) => e.detail > 1 && e.preventDefault()} className="cursor-pointer px-ch text-muted-foreground hover:bg-accent">
            ..
          </div>
          {b.error && <p className="px-ch whitespace-pre-wrap text-destructive">{b.error}</p>}
          {b.entries.map((e) =>
            row(
              e.key,
              "grid-cols-[2ch_1fr]",
              <>
                <span className={STATUS_CLASS(e.status)}>{e.status === "??" ? "U" : (e.status ?? "").slice(0, 1)}</span>
                <span className={cn("truncate", e.dir && "text-primary", e.key === selected && focused && "font-bold")}>
                  {e.name}
                  {e.dir && "/"}
                </span>
              </>,
            ),
          )}
        </div>
      </Box>
    </div>
  );
}
