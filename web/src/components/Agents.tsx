// The agents this machine can run (bridge/agents.ts): which it has, and
// for each it hasn't, its installer run from here or its website. Shown
// before Neovim on a machine with none (main.tsx), which can go on without
// one, and again whenever a session is asked for and there's still none
// (corkboard.agent's install): boxed over the page then.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { bridge } from "@/lib/bridge";
import { store, useStore } from "@/store";
import { cn } from "@/lib/utils";

export type Agent = { name: string; label: string; url: string; note: string | null; installed: boolean; command: string | null };
export type AgentsView = { agents: Agent[]; path: string; installing: string | null; failed: { name: string; error: string; output: string } | null; error?: string };
export type AgentsCall = (path: string, body?: unknown) => Promise<AgentsView>;

// done: with the bridge's PATH, for a Neovim already running to find what
// was installed. first: before Neovim, so leaving is "start" or "skip".
export function AgentsScreen({ call, done, first = false, initial }: { call: AgentsCall; done: (path?: string) => void; first?: boolean; initial?: AgentsView }) {
  const [view, setView] = useState<AgentsView | undefined>(initial);
  const [pick, setPick] = useState(0);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    if (!initial) call("/agents").then(setView, (e: Error) => setError(e.message));
  }, [call, initial]);
  // An installer runs on the bridge, which says when it's done.
  const installing = view?.installing ?? null;
  useEffect(() => {
    if (!installing) return;
    const t = setInterval(() => call("/agents").then(setView, () => {}), 1000);
    return () => clearInterval(t);
  }, [installing, call]);

  const agents = view?.agents ?? [];
  const any = agents.some((a) => a.installed);
  const at = agents[pick];
  const install = async (a: Agent) => {
    if (installing || a.installed || !a.command) return;
    setError(undefined);
    const r = await call("/agents/install", { name: a.name }).catch((e: Error) => ({ error: e.message }) as AgentsView);
    if (r.error) setError(r.error);
    else setView(r);
  };
  const site = (a: Agent) => window.open(a.url, "_blank", "noreferrer");
  const leave = () => done(view?.path);

  const keys = (e: React.KeyboardEvent) => {
    const k = e.key;
    const n = Number(k);
    if (n >= 1 && n <= agents.length) setPick(n - 1);
    else if (k === "ArrowDown" || k === "j") setPick((p) => (p + 1) % Math.max(agents.length, 1));
    else if (k === "ArrowUp" || k === "k") setPick((p) => (p + Math.max(agents.length, 1) - 1) % Math.max(agents.length, 1));
    else if (k === "i" && at) void install(at);
    else if (k === "o" && at) site(at);
    else if (k === "Enter" || k === "Escape") leave();
    else return;
    e.preventDefault();
  };

  const failed = view?.failed;
  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center font-mono text-foreground", first ? "bg-background" : "bg-background/80")}>
      <div
        ref={box}
        role="dialog"
        aria-label="agents"
        tabIndex={-1}
        onKeyDown={keys}
        className="flex w-[min(72ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pt-half pb-half outline-none"
      >
        <p className="text-primary">{first ? "corkboard" : "agents"}</p>
        <p className="mt-row">
          {any ? "Sessions run the agent you choose. These are the ones corkboard knows:" : "corkboard works with the coding agent you use. Install one to start a session:"}
        </p>
        <ol className="mt-half">
          {agents.map((a, i) => (
            <li key={a.name} onMouseEnter={() => setPick(i)} className={cn("flex flex-wrap items-baseline gap-x-2ch px-ch", i === pick && "bg-selection")}>
              <span className="min-w-[16ch]">
                <span className="text-primary">{i + 1}</span> {a.label}
              </span>
              <span className={cn("flex-1", a.installed ? "text-primary" : "text-muted-foreground")}>
                {a.installed ? "installed" : installing === a.name ? "installing…" : "not installed"}
              </span>
              {!a.installed && a.command && (
                <button type="button" disabled={!!installing} onClick={() => void install(a)} className="cursor-pointer px-half hover:bg-accent disabled:cursor-default disabled:opacity-50">
                  [ install ]
                </button>
              )}
              <a href={a.url} target="_blank" rel="noreferrer" className="px-half hover:bg-accent">
                [ {a.installed || a.command ? "website" : "download"} ]
              </a>
            </li>
          ))}
          {!view && !error && <li className="px-ch text-muted-foreground">…</li>}
        </ol>
        {at && !at.installed && (
          <p className="mt-half break-words text-muted-foreground">
            {at.command ? <span className="select-text">{at.command}</span> : at.note}
            {at.command && at.note ? ` · ${at.note}` : ""}
          </p>
        )}
        {failed && !installing && (
          <pre className="mt-half max-h-[12lh] overflow-auto whitespace-pre-wrap break-words text-blocked">
            {`${agents.find((a) => a.name === failed.name)?.label ?? failed.name} didn't install (${failed.error})${failed.output ? `\n${failed.output}` : ""}`}
          </pre>
        )}
        {error && <p className="mt-half break-words text-blocked">{error}</p>}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          {at && !at.installed && at.command && (
            <button type="button" disabled={!!installing} onClick={() => void install(at)} className="cursor-pointer px-half hover:bg-accent disabled:opacity-50">
              <span className="text-primary">i</span> install
            </button>
          )}
          {at && (
            <button type="button" onClick={() => site(at)} className="cursor-pointer px-half hover:bg-accent">
              <span className="text-primary">o</span> website
            </button>
          )}
          <button type="button" onClick={leave} className="cursor-pointer bg-primary px-half font-bold text-primary-foreground">
            ⏎ {!first ? "done" : any ? "start" : "later"}
          </button>
        </p>
      </div>
    </div>
  );
}

// Over the page, asked for from Neovim (corkboard.agents), which is told
// the bridge's PATH on the way out: an agent installed since it started is
// on that and not yet on its own.
export function Agents() {
  const open = useStore((s) => s.agents);
  const nvim = useNvim();
  if (!open) return null;
  const done = (path?: string) => {
    store.set({ agents: false });
    if (path) void nvim.lua("require('corkboard.agent').path(...)", path);
    nvim.refocus();
  };
  return <AgentsScreen call={bridge} done={done} />;
}
