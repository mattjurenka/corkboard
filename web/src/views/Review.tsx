// A card's review, in a float over the board. Neovim reads the card and
// its branch (corkboard.review) and owns the keys: A approves, S sends it
// back, q closes, j/k scroll; the buttons and a click on a diff line call
// back into it.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { md } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import type { ViewProps } from "./index";

type Entry = { time?: string; who?: string; text: string };
type DiffLine = [kind: "@" | "+" | "-" | " ", text: string, line: number | null];
type File = { path: string; status: "M" | "A" | "D" | "R"; added: number; removed: number; binary?: boolean; truncated?: boolean; lines: DiffLine[] };
type ReviewState = {
  id: string;
  title: string;
  branch?: string;
  main?: string;
  dir?: string;
  gone?: boolean;
  description: string;
  log: Entry[];
  summary?: { time?: string; text: string; verified: string };
  after?: Entry[];
  reviewer?: { risk?: string; summary: string; problems?: string[]; error?: boolean };
  files: File[];
  commits: { sha: string; subject: string }[];
  uncommitted?: string[];
  conflicts?: string[];
  dirty?: string[];
  scroll?: { by: number | "top" | "bottom"; seq: number };
};

const RISK: Record<string, string> = { low: "text-working", medium: "text-review", high: "text-blocked" };
const STATUS: Record<string, string> = { M: "text-review", A: "text-working", D: "text-blocked", R: "text-primary" };
const KIND: Record<string, string> = { "+": "text-working bg-working/10", "-": "text-blocked bg-blocked/10", "@": "text-muted-foreground", " ": "" };

const base = (p: string) => p.split("/").pop();

export function Review({ state, nvim }: ViewProps<ReviewState>) {
  const scroller = useRef<HTMLDivElement>(null);
  const cellH = useStore((s) => s.cell.h);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const call = (name: string) => nvim.lua("require('corkboard.review').action(...)", state.id, name);
  const openFile = (path: string, line?: number | null) =>
    state.dir && nvim.lua("require('corkboard.review').open_file(...)", `${state.dir}/${path}`, line ?? 1);

  useEffect(() => {
    const el = scroller.current;
    const s = state.scroll;
    if (!el || !s) return;
    if (s.by === "top") el.scrollTop = 0;
    else if (s.by === "bottom") el.scrollTop = el.scrollHeight;
    else el.scrollBy({ top: s.by * cellH });
  }, [state.scroll?.seq]);

  if (!state.id) return null;
  const added = state.files.reduce((n, f) => n + f.added, 0);
  const removed = state.files.reduce((n, f) => n + f.removed, 0);
  const blocked = !!(state.conflicts || state.dirty || state.uncommitted?.length);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b px-2ch pt-row pb-half">
        <div className="font-bold">
          <span className="text-primary">{state.id}</span> {state.title}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2ch">
          <div className="text-muted-foreground">
            {state.branch ? (
              <>
                {state.branch} → <span className="text-foreground">{state.main ?? "HEAD"}</span> · {state.commits.length} commit
                {state.commits.length === 1 ? "" : "s"} · {state.files.length} file{state.files.length === 1 ? "" : "s"}{" "}
                <span className="text-working">+{added}</span> <span className="text-blocked">−{removed}</span>
              </>
            ) : (
              "no branch"
            )}
          </div>
          <div className="flex gap-ch">
            <Button variant="link" size="cell" onClick={() => call("approve")} className={cn("hover:no-underline", blocked ? "text-muted-foreground" : "text-working")}>
              <kbd>A</kbd> approve{state.main ? " and merge" : ""}
            </Button>
            <Button variant="link" size="cell" onClick={() => call("send_back")} className="text-review hover:no-underline">
              <kbd>S</kbd> send back
            </Button>
            <Button variant="link" size="cell" onClick={() => call("close")} className="text-muted-foreground hover:no-underline">
              <kbd>q</kbd> close
            </Button>
          </div>
        </div>
      </header>

      <div ref={scroller} className="on-grid min-h-0 flex-1 overflow-y-auto px-2ch py-row">
        {(state.conflicts || state.dirty || state.uncommitted?.length || state.gone) && (
          <section className="mb-row">
            {state.conflicts && (
              <div className="text-blocked">
                ✗ conflicts with {state.main}: {state.conflicts.map(base).join(", ")}
              </div>
            )}
            {state.dirty && (
              <div className="text-blocked">
                ✗ uncommitted in {state.main}: {state.dirty.map(base).join(", ")}
              </div>
            )}
            {!!state.uncommitted?.length && <div className="text-blocked">✗ uncommitted in the worktree: {state.uncommitted.length} files</div>}
            {state.gone && <div className="text-muted-foreground">· worktree removed; the branch is still there</div>}
          </section>
        )}

        {state.reviewer && (
          <section className="mb-row">
            <H>
              reviewer{" "}
              {state.reviewer.error ? (
                <span className="text-blocked">✗ not reviewed</span>
              ) : (
                state.reviewer.risk && <span className={RISK[state.reviewer.risk]}>{state.reviewer.risk} risk</span>
              )}
            </H>
            <article className="markdown-body" dangerouslySetInnerHTML={md(state.reviewer.summary)} />
            {state.reviewer.problems?.map((p) => (
              <div key={p} className="text-blocked">
                ✗ {p}
              </div>
            ))}
          </section>
        )}

        {state.summary && (
          <section className="mb-row">
            <H>
              summary <span className="text-muted-foreground">{state.summary.time}</span>
            </H>
            <article className="markdown-body" dangerouslySetInnerHTML={md(state.summary.text)} />
            <Fold label="verified">
              <article className="markdown-body text-muted-foreground" dangerouslySetInnerHTML={md(state.summary.verified)} />
            </Fold>
          </section>
        )}

        {!!state.after?.length && (
          <section className="mb-row">
            <H>since then</H>
            {state.after.map((e, i) => (
              <LogEntry key={i} entry={e} />
            ))}
          </section>
        )}

        {state.files.length > 0 && (
          <section className="mb-row">
            <H>files</H>
            {state.files.map((f) => (
              <div key={f.path}>
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [f.path]: !o[f.path] }))}
                  className="flex w-full cursor-pointer gap-ch text-left hover:bg-accent"
                >
                  <span className="text-muted-foreground">{open[f.path] ? "▾" : "▸"}</span>
                  <span className={STATUS[f.status]}>{f.status}</span>
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="tabular-nums">
                    <span className="text-working">+{f.added}</span> <span className="text-blocked">−{f.removed}</span>
                  </span>
                </button>
                {open[f.path] && <Diff file={f} onLine={(line) => openFile(f.path, line)} />}
              </div>
            ))}
          </section>
        )}

        {state.commits.length > 0 && (
          <section className="mb-row">
            <H>commits</H>
            {state.commits.map((c) => (
              <div key={c.sha} className="truncate">
                <span className="text-muted-foreground">{c.sha}</span> {c.subject}
              </div>
            ))}
          </section>
        )}

        {state.description && (
          <Fold label="what was asked">
            <article className="markdown-body" dangerouslySetInnerHTML={md(state.description)} />
          </Fold>
        )}
        {state.log.length > 0 && (
          <Fold label={`full log ${state.log.length}`}>
            {state.log.map((e, i) => (
              <LogEntry key={i} entry={e} />
            ))}
          </Fold>
        )}
      </div>
    </div>
  );
}

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mb-half font-bold">{children}</h2>;

function Fold({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-row">
      <button type="button" onClick={() => setOpen(!open)} className="cursor-pointer text-muted-foreground hover:text-foreground">
        {open ? "▾" : "▸"} {label}
      </button>
      {open && <div className="pl-2ch">{children}</div>}
    </div>
  );
}

function LogEntry({ entry }: { entry: Entry }) {
  return (
    <div className="mb-half">
      {entry.time && (
        <div className="text-muted-foreground">
          {entry.time} · {entry.who}
        </div>
      )}
      <article className="markdown-body" dangerouslySetInnerHTML={md(entry.text)} />
    </div>
  );
}

function Diff({ file, onLine }: { file: File; onLine: (line: number | null) => void }) {
  if (file.binary) return <div className="pl-2ch text-muted-foreground">binary</div>;
  return (
    <div className="mb-half overflow-x-auto border-l pl-ch">
      {file.lines.map(([kind, text, line], i) => (
        <div
          key={i}
          onClick={() => onLine(line)}
          className={cn("flex cursor-pointer whitespace-pre hover:bg-accent", KIND[kind])}
        >
          <span className="w-[5ch] shrink-0 pr-ch text-right text-muted-foreground tabular-nums select-none">
            {kind === "-" || kind === "@" ? "" : line}
          </span>
          <span className="w-[2ch] shrink-0 select-none">{kind === "@" || kind === " " ? "" : kind}</span>
          <span>{kind === "@" ? text.replace(/^@@[^@]*@@ ?/, "") || "⋯" : text}</span>
        </div>
      ))}
      {file.truncated && <div className="text-muted-foreground">⋯</div>}
    </div>
  );
}
