// Away mode (corkboard/away.lua, bridge/away.ts): the whole page black, with
// a dot for each Claude Code session in every project and a count under
// them. Any key shows them as a list; when the bridge wakes you, the list
// comes up on its own with why, and what's asking at the top. Keys stop
// here while it's up, so none reach Neovim.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { type AwaySession, store, useStore } from "@/store";

const GLYPH = { working: "●", needs: "▲", ready: "○", idle: "·" };
const COLOR = { working: "text-working", needs: "text-blocked", ready: "text-primary", idle: "text-muted-foreground" };
const ORDER = { needs: 0, ready: 1, working: 2, idle: 3 };
const WORD = { working: "working", needs: "needs you", ready: "ready", idle: "idle" };

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60000));
const clock = (ms: number) => {
  const m = minutes(ms);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const ago = (ms: number) => {
  const m = minutes(ms);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

export function Away() {
  const away = useStore((s) => s.away);
  const nvim = useNvim();
  const [listed, setListed] = useState(false);
  const [picked, setPicked] = useState(0);
  const [now, setNow] = useState(Date.now());

  // The bridge's clock, as this page's.
  const skew = useMemo(() => (away ? Date.now() - away.now : 0), [away]);
  const sessions = useMemo(
    () => [...(away?.sessions ?? [])].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.at - b.at),
    [away],
  );
  const shown = !!away?.wake || listed;

  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [!away]);
  // Waking (or leaving) starts again at the top: what's asking, else what's done.
  useEffect(() => {
    setPicked(0);
    if (!away) setListed(false);
  }, [away?.wake, !away]);

  useEffect(() => {
    if (!away) return;
    const command = (op: string, ...args: unknown[]) => nvim.notify("corkboard.away", op, ...args);
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      // The browser's own shortcuts (reload, devtools) still work.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      // Left here at once, whether or not the bridge answers.
      if (e.key === "Escape") {
        command("leave");
        return store.set({ away: null });
      }
      if (!shown) return setListed(true);
      const s = sessions[picked];
      if ((e.key === "j" || e.key === "ArrowDown") && picked < sessions.length - 1) setPicked(picked + 1);
      else if ((e.key === "k" || e.key === "ArrowUp") && picked > 0) setPicked(picked - 1);
      else if (e.key === "Enter" && s) command("go", s.page, s.buf);
      else if (e.key === " " && away.wake) command("stay");
      else if (!["j", "k", "ArrowDown", "ArrowUp", "Shift"].includes(e.key) && !away.wake) setListed(false);
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [away, shown, sessions, picked]);

  if (!away) return null;
  const elapsed = now - skew - away.since;
  const count = (state: AwaySession["state"]) => sessions.filter((s) => s.state === state).length;
  const counts = (["working", "ready", "needs"] as const)
    .filter((state) => count(state))
    .map((state) => `${count(state)} ${WORD[state]}`)
    .join(" · ");

  if (!shown) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[calc(var(--cell-h)*1.5)] bg-black text-muted-foreground">
        {sessions.length ? (
          <>
            <div className="flex gap-2ch text-[1.5em] leading-[1.5]">
              {sessions.map((s) => (
                <span key={`${s.page}:${s.buf}`} className={cn(COLOR[s.state], s.state === "working" && "animate-breathe")}>
                  {GLYPH[s.state]}
                </span>
              ))}
            </div>
            <span>{counts || "all idle"}</span>
          </>
        ) : (
          <span>no Claude Code sessions</span>
        )}
        <span className="absolute bottom-row">any key shows the list · esc back</span>
      </div>
    );
  }

  const asking = sessions[picked]?.state === "needs" ? sessions[picked] : undefined;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[calc(var(--cell-h)*1.5)] bg-black">
      <div className="flex gap-2ch text-muted-foreground">
        <span className={away.wake ? "text-blocked" : "text-working"}>{away.wake ? "▲" : "●"}</span>
        <span>
          away {clock(elapsed)}
          {away.wake && ` · ${away.wake}`}
        </span>
      </div>
      {asking && (
        <div className="flex w-[80ch] max-w-[calc(100%-4ch)] flex-col border border-blocked px-3ch py-half">
          <span className="font-bold text-blocked">
            ▲ {asking.project} · {asking.name}
          </span>
          <span>{asking.detail ?? "waiting on you"}</span>
        </div>
      )}
      <ol className="w-[80ch] max-w-[calc(100%-4ch)]">
        {sessions.length === 0 && <li className="text-muted-foreground">no Claude Code sessions</li>}
        {sessions.map((s, i) => (
          <li
            key={`${s.page}:${s.buf}`}
            className={cn("grid grid-cols-[3ch_16ch_1fr_10ch_6ch]", i === picked && "bg-selection")}
          >
            <span className={COLOR[s.state]}>{GLYPH[s.state]}</span>
            <span className="truncate">{s.project}</span>
            <span className="truncate text-muted-foreground">{s.name}</span>
            <span className={COLOR[s.state]}>{WORD[s.state]}</span>
            <span className="text-right text-muted-foreground">{ago(now - skew - s.at)}</span>
          </li>
        ))}
      </ol>
      <div className="flex w-[80ch] max-w-[calc(100%-4ch)] flex-wrap gap-x-3ch text-muted-foreground">
        <span><kbd className="text-foreground">↵</kbd> go to it</span>
        <span><kbd className="text-foreground">j k</kbd> pick another</span>
        {away.wake ? (
          <span><kbd className="text-foreground">space</kbd> stay away</span>
        ) : (
          <span><kbd className="text-foreground">any key</kbd> hide the list</span>
        )}
        <span><kbd className="text-foreground">esc</kbd> back</span>
      </div>
    </div>
  );
}
