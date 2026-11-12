// A Claude Code session's conversation from the fleet view, or an ACP
// agent's session (corkboard.acp), drawn the way the terminal draws one
// (corkboard.conversation, which follows it and sends what's said here): your turns shaded behind a › , Claude's as markdown
// behind a ●, each tool a ● row with its result under a └ that opens to the
// whole of it, and a boxed prompt at the foot. On the grid, like the panels.
//
// Keys stay with Neovim until the composer is clicked (or i, a, o in the
// window, which bump focus); Escape gives them back. Text can be selected,
// and any key but a copy goes back to Neovim.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import type { ViewProps } from "./index";

type Option = { label?: string; description?: string };
type Question = { header?: string; question?: string; multiSelect?: boolean; options?: Option[] };
type Item = {
  kind: "you" | "claude" | "tool" | "note";
  id: string;
  text?: string;
  tool?: string;
  detail?: string;
  call?: string;
  error?: boolean;
};
type Result = { call: string; text?: string; error?: boolean };
type State = {
  name?: string;
  where?: { vm?: string; brain?: string; account?: string; host?: string; dir?: string };
  items?: Item[];
  results?: Record<string, Result> | [];
  // What it's saying that isn't an item yet.
  live?: string | null;
  state?: "starting" | "working" | "asking" | "permission" | "stopping" | null;
  status?: string | null;
  ended?: boolean;
  questions?: Question[] | null;
  ask?: { step: number; picks: number[]; other?: string | null } | null;
  answers?: string[];
  focus?: number;
};

const STATE_CLASS: Record<string, string> = {
  starting: "text-working",
  working: "text-working",
  stopping: "text-working",
  asking: "text-review",
  permission: "text-review",
  ended: "text-muted-foreground",
};

// A row with a mark in the first two columns and the rest beside it.
const ROW = "grid grid-cols-[2ch_minmax(0,1fr)]";

export function Conversation({ state, win, buf, nvim }: ViewProps<State>) {
  const items = state.items ?? [];
  const results = (Array.isArray(state.results) ? {} : state.results) ?? {};
  const call = (fn: string, ...args: unknown[]) => void nvim.lua(`require('corkboard.conversation').${fn}(...)`, buf, ...args);
  const current = () => void nvim.lua("local w = ... if vim.api.nvim_win_is_valid(w) then vim.api.nvim_set_current_win(w) end", win);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  // Kept at the newest, unless scrolled back.
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  });

  // A press in the transcript selects text rather than keeping focus on the
  // canvas (Panels.tsx); let go with nothing selected, and it goes back.
  const own = (e: React.MouseEvent) => {
    e.stopPropagation();
    current();
  };
  const release = () => {
    if (!getSelection()?.toString()) nvim.refocus();
  };

  const questions = state.questions ?? null;
  const ask = state.ask ?? null;
  const q = questions && ask ? questions[Math.min(ask.step, questions.length) - 1] : null;
  const answers = !q ? (state.answers ?? []) : [];
  const where = [state.where?.vm, state.where?.host, state.where?.dir].filter(Boolean).join(" · ");
  const shown = state.ended ? "ended" : (state.state ?? null);

  return (
    <div className="on-grid flex h-full flex-col">
      <header className="flex shrink-0 justify-between gap-2ch px-2ch py-row">
        <span className="flex min-w-0 gap-2ch">
          <span className="truncate font-bold">{state.name}</span>
          {where && <span className="truncate text-muted-foreground">{where}</span>}
        </span>
        {shown && <span className={cn("flex-none", STATE_CLASS[shown])}>{shown}</span>}
      </header>

      <div
        ref={scroller}
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        onMouseDown={own}
        onMouseUp={release}
        onKeyDown={(e) => {
          if (!((e.ctrlKey || e.metaKey) && e.key === "c")) nvim.refocus();
        }}
        className="min-h-0 flex-1 overflow-y-auto pb-row outline-none select-text"
      >
        <div className="flex flex-col gap-row">
          {items.map((t) =>
            t.kind === "you" ? (
              <div key={t.id} className={cn(ROW, "bg-muted px-2ch")}>
                <span className="text-primary">›</span>
                <span className="whitespace-pre-wrap break-words">{t.text}</span>
              </div>
            ) : t.kind === "claude" ? (
              <div key={t.id} className={cn(ROW, "px-2ch")}>
                <span>●</span>
                <Markdown text={t.text ?? ""} />
              </div>
            ) : t.kind === "note" ? (
              <div key={t.id} className={cn("px-2ch whitespace-pre-wrap", t.error ? "text-destructive" : "text-muted-foreground")}>
                {t.text}
              </div>
            ) : (
              <Tool
                key={t.id}
                item={t}
                result={t.call ? results[t.call] : undefined}
                open={!!opened[t.id]}
                toggle={() => setOpened((o) => ({ ...o, [t.id]: !o[t.id] }))}
              />
            ),
          )}

          {state.live && (
            <div className={cn(ROW, "px-2ch")}>
              <span>●</span>
              <Markdown text={state.live} />
            </div>
          )}

          {state.state === "working" && <div className="px-2ch text-working">✻ working…</div>}

          {q && ask && questions && (
            <section className="mx-2ch mt-half border border-review px-ch pb-half">
              <h2 className="-mt-half flex justify-between gap-ch">
                <span className="truncate bg-background px-half font-bold text-review">{q.header}</span>
                {questions.length > 1 && (
                  <span className="flex-none bg-background px-half text-muted-foreground">
                    {ask.step}/{questions.length}
                  </span>
                )}
              </h2>
              <p className="mb-half px-half whitespace-pre-wrap">{q.question}</p>
              <ul>
                {(q.options ?? []).map((o, i) => {
                  const picked = ask.picks.includes(i);
                  return (
                    <li
                      key={i}
                      onClick={() => call("pick", i + 1)}
                      className={cn("grid cursor-pointer grid-cols-[4ch_minmax(0,1fr)] px-half hover:bg-accent", picked && "bg-selection hover:bg-selection")}
                    >
                      <span className="text-primary">{q.multiSelect ? (picked ? "[x]" : "[ ]") : i + 1}</span>
                      <span className={cn(picked && "font-bold")}>{o.label}</span>
                      {o.description && o.description !== o.label && (
                        <span className="col-start-2 text-muted-foreground">{o.description}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {ask.other && (
                <div className={cn(ROW, "mt-half bg-muted px-half")}>
                  <span className="text-primary">›</span>
                  <span className="whitespace-pre-wrap break-words">{ask.other}</span>
                </div>
              )}
              {(q.multiSelect || ask.other) && (
                <p className="mt-half flex justify-end">
                  <Key k="⏎" onClick={() => call("submit", "")}>
                    {ask.step < questions.length ? "next" : "send"}
                  </Key>
                </p>
              )}
            </section>
          )}

          {answers.length > 0 && (
            <div className="flex flex-wrap gap-x-2ch px-2ch">
              {answers.map((a, i) => (
                <Key key={i} k={String(i + 1)} onClick={() => call("pick", i + 1)}>
                  {a}
                </Key>
              ))}
            </div>
          )}

          {state.status && (
            <div className="flex justify-center gap-2ch px-2ch text-muted-foreground">
              {state.status}
              {state.ended && (
                <Key k="R" onClick={() => call("refollow")}>
                  reconnect
                </Key>
              )}
            </div>
          )}
        </div>
      </div>

      <Composer
        working={state.state === "working"}
        focus={state.focus ?? 0}
        nvim={nvim}
        current={current}
        send={(text) => call("submit", text)}
        stop={() => call("interrupt")}
      />
    </div>
  );
}

// A key hint that can be clicked as well as typed, like the fleet's y / n.
function Key({ k, onClick, children }: { k: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="cursor-pointer px-half hover:bg-accent">
      <span className="text-primary">{k}</span> {children}
    </button>
  );
}

// A turn's text never changes once said, so each renders once.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false })), [text]);
  return <div className="markdown-body chat" onClick={follow} dangerouslySetInnerHTML={{ __html: html }} />;
});

// A link opens in a tab of the browser's, never in place of the page.
function follow(e: React.MouseEvent) {
  const a = (e.target as Element).closest("a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href")!;
  if (/^(https?|mailto):/i.test(href)) window.open(href, "_blank", "noopener");
}

// ● Name detail, and under it └ the result: two lines of it, or all of it
// (and all of the detail) once opened.
function Tool({ item, result, open, toggle }: { item: Item; result?: Result; open: boolean; toggle: () => void }) {
  const detail = item.detail ?? "";
  const text = result?.text ?? "";
  const agent = item.tool === "Agent" || item.tool === "Task";
  return (
    <div onClick={toggle} className="cursor-pointer px-2ch hover:bg-accent">
      <div className={ROW}>
        <span className={cn(!result ? "animate-pulse-dot text-working" : result.error ? "text-destructive" : "text-muted-foreground")}>●</span>
        <span className={cn("min-w-0", open ? "whitespace-pre-wrap break-words" : "truncate")}>
          <span className="font-bold">{item.tool}</span>{" "}
          <span className="text-muted-foreground">{open ? detail : detail.split("\n")[0]}</span>
        </span>
      </div>
      {text && (
        <div className="grid grid-cols-[4ch_minmax(0,1fr)]">
          <span className="whitespace-pre text-muted-foreground">{"  └"}</span>
          {open && agent && !result?.error ? (
            <Markdown text={text} />
          ) : (
            <span className={cn(result?.error ? "text-destructive" : "text-muted-foreground", open ? "whitespace-pre-wrap break-words" : "line-clamp-2 whitespace-pre")}>
              {open ? text : text.split("\n").slice(0, 2).join("\n")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({
  working,
  focus,
  nvim,
  current,
  send,
  stop,
}: {
  working: boolean;
  focus: number;
  nvim: Nvim;
  current: () => void;
  send: (text: string) => void;
  stop: () => void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // i, a or o in the window (corkboard.conversation), not its first state.
  const seen = useRef(focus);
  useEffect(() => {
    if (focus !== seen.current) field.current?.focus();
    seen.current = focus;
  }, [focus]);

  // As tall as what's in it, up to eight lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    send(text);
    setText("");
  };

  return (
    <div className={cn(ROW, "mx-2ch mb-row shrink-0 border px-ch focus-within:border-focus")}>
      <span className="text-primary">›</span>
      <div className="flex min-w-0 items-end gap-2ch">
        <textarea
          ref={field}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onMouseDown={(e) => {
            e.stopPropagation();
            current();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              nvim.refocus();
            } else if (e.key === "c" && e.ctrlKey && !text) {
              e.preventDefault();
              stop();
            }
          }}
          className="max-h-[calc(var(--cell-h)*8)] min-h-(--cell-h) flex-1 resize-none bg-transparent font-[inherit] outline-none"
        />
        {working && !text ? (
          <Key k="^C" onClick={stop}>
            stop
          </Key>
        ) : (
          text.trim() && (
            <Key k="⏎" onClick={submit}>
              send
            </Key>
          )
        )}
      </div>
    </div>
  );
}
