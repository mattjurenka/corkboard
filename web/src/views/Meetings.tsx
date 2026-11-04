// The Meetings tab (corkboard.meetings): the meetings recorded on the
// bridge's machine, newest first, beside the selected one's transcript, and
// the button that starts or stops the recorder, and its proposed action
// items, checked to be made cards. Drawn over agent://meetings,
// which owns the cursor and the keys; a click selects, a button acts.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Status = "recording" | "transcribing" | "sent" | "failed" | "interrupted";
type Meeting = { id: string; when: string; minutes: number; status: Status; detail: string; said: number };
type Line = { track: string; speaker: number; who: string; at: string; text: string };
// What's being said on a track, not yet a line.
type Partial = { track: string; at: string; text: string };
// An action item, by its index in the meeting's; card and on once it's one.
type Proposal = {
  i: number;
  title: string;
  description: string;
  owner: string;
  board?: string;
  at: string;
  quote: string;
  card?: string;
  on?: string;
};
type Board = { key: string; name: string };
type MeetingsState = {
  available: boolean;
  recording?: { id: string; at: number; since: string };
  pending?: "starting" | "stopping";
  selected?: string;
  meetings: Meeting[];
  transcript?: Line[];
  partial?: Partial[];
  proposals?: Proposal[];
  boards?: Board[];
  working?: "proposing" | "accepting" | "dropping";
  unproposed?: string;
};

const TONE: Record<Status, string> = {
  recording: "text-destructive",
  transcribing: "text-working",
  sent: "text-muted-foreground",
  failed: "text-blocked",
  interrupted: "text-blocked",
};

const MARK: Record<Status, string> = { recording: "●", transcribing: "◐", sent: "✓", failed: "!", interrupted: "!" };

// Each voice its own color: Me's is the primary, the others' by track.
const THEM = ["text-special", "text-review", "text-focus", "text-blocked"];
const ROOM = ["text-working", "text-review", "text-focus", "text-special"];
const tone = (l: { track: string; speaker: number; who: string }) =>
  l.who === "Me" ? "text-primary" : (l.track === "out" ? THEM : ROOM)[l.speaker % THEM.length];

// 03:12, or 1:03:12.
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const meetings = (fn: string) => `require('corkboard.meetings').${fn}(...)`;

// Yours are checked to start with, and a follow-up for someone else isn't.
function ActionItems({ id, state, nvim }: { id: string; state: MeetingsState; nvim: ViewProps<MeetingsState>["nvim"] }) {
  const items = state.proposals ?? [];
  const boards = state.boards ?? [];
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [board, setBoard] = useState<Record<number, string>>({});
  const [title, setTitle] = useState<Record<number, string>>({});
  const name = (key?: string) => boards.find((b) => b.key === key)?.name ?? key;
  const open = items.filter((p) => !p.card);
  const boardOf = (p: Proposal) => board[p.i] ?? p.board ?? "";
  const isPicked = (p: Proposal) => !!boardOf(p) && (picked[p.i] ?? p.owner === "me");
  const picks = open.filter(isPicked);
  const busy = !!state.working;

  return (
    <div className="flex w-[52ch] flex-none flex-col gap-row overflow-y-auto border-l pl-2ch">
      <span className="flex items-baseline gap-2ch">
        <span className="font-bold">Action items</span>
        {state.working ? (
          <span className="text-working">◌ {state.working}…</span>
        ) : (
          <button
            type="button"
            title="Propose again (p)"
            onClick={() => nvim.lua(meetings("propose"), id)}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            ↻
          </button>
        )}
      </span>
      {state.unproposed && <p className="text-blocked">{state.unproposed}</p>}
      {items.map((p) =>
        p.card ? (
          <div key={p.i} className="flex gap-ch text-muted-foreground">
            <span className="w-3ch flex-none text-center text-primary">✓</span>
            <span className="flex-1">
              {p.title} <span className="text-border">→ {p.card} on {name(p.on)}</span>
            </span>
          </div>
        ) : (
          <div key={p.i} className="group flex gap-ch" title={`${p.description}\n\n${p.at} “${p.quote}”`}>
            <button
              type="button"
              disabled={!boardOf(p)}
              onClick={() => setPicked({ ...picked, [p.i]: !isPicked(p) })}
              className={cn("w-3ch flex-none cursor-pointer self-start disabled:cursor-default", isPicked(p) ? "text-primary" : "text-muted-foreground")}
            >
              {isPicked(p) ? "[x]" : "[ ]"}
            </button>
            <div className="flex min-w-0 flex-1 flex-col">
              <input
                value={title[p.i] ?? p.title}
                onChange={(e) => setTitle({ ...title, [p.i]: e.target.value })}
                className="w-full bg-transparent outline-none focus:bg-accent"
              />
              <span className="flex gap-ch text-muted-foreground">
                <span className={cn("truncate", p.owner === "me" ? "text-primary" : "text-special")}>{p.owner}</span>
                <span className="tabular-nums">{p.at}</span>
                <select
                  value={boardOf(p)}
                  onChange={(e) => setBoard({ ...board, [p.i]: e.target.value })}
                  className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent hover:text-foreground"
                >
                  <option value="">—</option>
                  {boards.map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  title="Drop"
                  disabled={busy}
                  onClick={() => nvim.lua(meetings("drop"), id, p.i)}
                  className="flex-none cursor-pointer opacity-0 group-hover:opacity-100 hover:text-foreground"
                >
                  ✕
                </button>
              </span>
            </div>
          </div>
        ),
      )}
      {!items.length && !state.working && !state.unproposed && <p className="text-border">—</p>}
      {open.length > 0 && (
        <button
          type="button"
          disabled={busy || !picks.length}
          onClick={() =>
            nvim.lua(
              meetings("accept"),
              id,
              picks.map((p) => ({ i: p.i, board: boardOf(p), title: title[p.i] ?? p.title })),
            )
          }
          className="cursor-pointer self-start border px-ch hover:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          + {picks.length} card{picks.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

export function Meetings({ state, win, focused, nvim }: ViewProps<MeetingsState>) {
  const list = useRef<HTMLUListElement>(null);
  const said = useRef<HTMLDivElement>(null);
  const now = useTick(!!state.recording);
  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  // Kept at the bottom while it's being said, as a terminal is.
  const live = state.recording && state.recording.id === state.selected;
  const lines = state.transcript ?? [];
  const partial = state.partial ?? [];
  useEffect(() => {
    if (live && said.current) said.current.scrollTop = said.current.scrollHeight;
  }, [live, lines.length, partial.map((p) => p.text).join()]);

  const selected = state.meetings.find((m) => m.id === state.selected);
  // Runs of the same speaker, under one name.
  const runs: { who: string; track: string; speaker: number; lines: Line[] }[] = [];
  for (const l of lines) {
    const last = runs[runs.length - 1];
    if (last && last.track === l.track && last.speaker === l.speaker) last.lines.push(l);
    else runs.push({ who: l.who, track: l.track, speaker: l.speaker, lines: [l] });
  }

  return (
    <div className="flex h-full flex-col gap-row px-2ch pt-row pb-row">
      <header className="flex items-baseline gap-2ch">
        <span className="font-bold">Meetings</span>
        {state.available && (
          <button
            type="button"
            title={state.recording ? "Stop (m)" : "Record (m)"}
            disabled={!!state.pending}
            onClick={() => nvim.lua(meetings("toggle"))}
            className={cn(
              "cursor-pointer border px-ch hover:bg-accent disabled:cursor-wait disabled:text-muted-foreground",
              state.recording && "border-destructive text-destructive",
            )}
          >
            {state.pending
              ? `◌ ${state.pending}…`
              : state.recording
                ? `■ stop  ${elapsed(now - state.recording.at)}`
                : "● record"}
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 gap-2ch">
        <ul ref={list} className="w-[44ch] flex-none overflow-y-auto border-r pr-ch">
          {state.meetings.map((m) => (
            <li
              key={m.id}
              data-selected={m.id === state.selected || undefined}
              onMouseDownCapture={() => m.id !== state.selected && nvim.lua(meetings("select"), m.id, win)}
              className={cn("group flex cursor-pointer flex-col px-ch", m.id === state.selected ? "bg-selection" : "hover:bg-accent")}
            >
              <span className="flex gap-ch">
                <span className={cn("w-ch flex-none", TONE[m.status])}>{MARK[m.status]}</span>
                <span className={cn("flex-1 truncate", m.id === state.selected && focused && "font-bold")}>{m.when}</span>
                <span className="flex-none text-muted-foreground tabular-nums">{m.minutes} min</span>
              </span>
              <span className="flex gap-ch pl-2ch">
                <span className={cn("flex-1 truncate", TONE[m.status])}>{m.detail}</span>
                {m.status === "failed" && (
                  <button
                    type="button"
                    title="Send again (r)"
                    onClick={() => nvim.lua(meetings("finish"), m.id)}
                    className="flex-none cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    ↻ retry
                  </button>
                )}
              </span>
            </li>
          ))}
          {!state.meetings.length && <li className="px-ch text-border">—</li>}
        </ul>
        <div ref={said} className="flex min-w-0 flex-1 flex-col gap-row overflow-y-auto">
          {runs.map((r, i) => (
            <div key={i} className="flex flex-col">
              <span className={cn("font-bold", tone(r))}>
                {r.who} <span className="font-normal text-muted-foreground tabular-nums">{r.lines[0].at}</span>
              </span>
              {r.lines.map((l, j) => (
                <p key={j} title={l.at} className="pl-2ch">
                  {l.text}
                </p>
              ))}
            </div>
          ))}
          {partial.map((p) => (
            <div key={p.track} className="flex flex-col text-muted-foreground">
              {runs.at(-1)?.track !== p.track && <span>{p.track === "in" ? "Me" : "Them"}…</span>}
              <p title={p.at} className="pl-2ch">
                {p.text}…
              </p>
            </div>
          ))}
          {selected && !runs.length && !partial.length && <p className="text-border">—</p>}
        </div>
        {selected && (state.proposals || state.working || state.unproposed) && (
          <ActionItems key={selected.id} id={selected.id} state={state} nvim={nvim} />
        )}
      </div>
    </div>
  );
}
