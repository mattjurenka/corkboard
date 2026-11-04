// The Meetings tab (corkboard.meetings): the meetings recorded on the
// bridge's machine, newest first, beside the selected one's transcript, and
// the button that starts or stops the recorder. Drawn over agent://meetings,
// which owns the cursor and the keys; a click selects, a button acts.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ViewProps } from "./index";

type Status = "recording" | "transcribing" | "sent" | "failed" | "interrupted";
type Meeting = { id: string; when: string; minutes: number; status: Status; detail: string; said: number };
type Line = { track: string; who: string; at: string; text: string };
type MeetingsState = {
  available: boolean;
  recording?: { id: string; at: number; since: string };
  selected?: string;
  meetings: Meeting[];
  transcript?: Line[];
};

const TONE: Record<Status, string> = {
  recording: "text-destructive",
  transcribing: "text-working",
  sent: "text-muted-foreground",
  failed: "text-blocked",
  interrupted: "text-blocked",
};

const MARK: Record<Status, string> = { recording: "●", transcribing: "◐", sent: "✓", failed: "!", interrupted: "!" };

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
  useEffect(() => {
    if (live && said.current) said.current.scrollTop = said.current.scrollHeight;
  }, [live, lines.length]);

  const selected = state.meetings.find((m) => m.id === state.selected);
  // Runs of the same speaker, under one name.
  const runs: { who: string; track: string; lines: Line[] }[] = [];
  for (const l of lines) {
    const last = runs[runs.length - 1];
    if (last && last.track === l.track) last.lines.push(l);
    else runs.push({ who: l.who, track: l.track, lines: [l] });
  }

  return (
    <div className="flex h-full flex-col gap-row px-2ch pt-row pb-row">
      <header className="flex items-baseline gap-2ch">
        <span className="font-bold">Meetings</span>
        {state.available && (
          <button
            type="button"
            title={state.recording ? "Stop (m)" : "Record (m)"}
            onClick={() => nvim.lua(meetings("toggle"))}
            className={cn("cursor-pointer border px-ch hover:bg-accent", state.recording && "border-destructive text-destructive")}
          >
            {state.recording ? `■ stop  ${elapsed(now - state.recording.at)}` : "● record"}
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
              <span className={cn("font-bold", r.track === "in" ? "text-primary" : "text-special")}>
                {r.who} <span className="font-normal text-muted-foreground tabular-nums">{r.lines[0].at}</span>
              </span>
              {r.lines.map((l, j) => (
                <p key={j} title={l.at} className="pl-2ch">
                  {l.text}
                </p>
              ))}
            </div>
          ))}
          {selected && !runs.length && <p className="text-border">—</p>}
        </div>
      </div>
    </div>
  );
}
