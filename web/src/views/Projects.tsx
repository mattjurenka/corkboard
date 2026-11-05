// The projects view: a card per project, boxed with its name on the border,
// where it is, its remote and its board as labelled fields, and what you can
// do with it along its foot. Drawn over agent://projects (corkboard.projects),
// which owns the cursor and the keys; a click selects, a button acts, and a
// double click opens, here while no project is open, else in a window of its
// own (or the one it has already).

import { useEffect, useRef } from "react";
import { openProject, short } from "@/components/Projects";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/utils";
import type { Nvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { Button, Field } from "./Brains";
import type { ViewProps } from "./index";

type Project = {
  id: string;
  name: string;
  path?: string;
  where?: string;
  remote?: string;
  board?: string;
  recent?: boolean;
  current?: boolean;
};
type ProjectsState = { projects: Project[]; selected?: string; problem?: string; dir: string; none?: boolean; loading?: boolean };

// A project of the listing opened, as Open project opens one: the account's
// through its clone (cloned first when there's none here), the rest by path.
export async function openListed(nvim: Nvim, p: Project, here: boolean) {
  if (p.path && store.get().windows.includes(p.path)) return nvim.notify("corkboard.window", p.path);
  const code = p.board ? "return require('corkboard.picker').open_project(...)" : "return require('corkboard.picker').open_path(...)";
  const err = await openProject(nvim, code, p.board ? { ...p, key: p.board } : p.path, here);
  if (err) {
    const t = { id: `project:${p.id}`, kind: "error" as const, text: err };
    store.set({ toasts: [...store.get().toasts.filter((o) => o.id !== t.id), t] });
    setTimeout(() => store.set({ toasts: store.get().toasts.filter((o) => o !== t) }), 8000);
  }
}

export function Projects({ state, win, focused, nvim }: ViewProps<ProjectsState>) {
  const root = useRef<HTMLDivElement>(null);
  const windows = useStore((s) => s.windows);
  useEffect(() => {
    root.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);
  const pick = (id: string) => nvim.lua("require('corkboard.projects').select(...)", id, win);
  const open = (p: Project) => openListed(nvim, p, !state.none);
  const forget = (id: string) => nvim.lua("require('corkboard.projects').forget(...)", id);
  const make = () => store.set({ projects: { here: !state.none, naming: true } });
  const list = state.projects ?? [];

  return (
    <div ref={root} className="flex h-full flex-col gap-row overflow-y-auto px-2ch pt-row pb-row">
      <header className="flex items-baseline justify-between gap-2ch">
        <span className="font-bold">Projects</span>
        {!state.none && (
          <Button k="n" lit onClick={make}>
            new project
          </Button>
        )}
      </header>
      {state.none && (
        <button
          type="button"
          onClick={make}
          className="flex h-[calc(3*var(--cell-h))] cursor-pointer items-center gap-ch self-start bg-primary px-2ch font-bold text-primary-foreground hover:bg-primary/90"
        >
          <span>+</span>
          <span>New project</span>
          <span className="opacity-70">n</span>
        </button>
      )}
      {state.problem && <p className="px-ch text-destructive">{state.problem}</p>}
      {state.loading && <Spinner className="h-[calc(var(--cell-h)*4)]" />}
      {list.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(44ch,1fr))] items-start gap-x-2ch gap-y-row">
          {list.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              on={p.id === state.selected}
              focused={focused}
              windowed={!!p.path && windows.includes(p.path) && !p.current}
              onPick={pick}
              onOpen={open}
              onForget={forget}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project: p,
  on,
  focused,
  windowed,
  onPick,
  onOpen,
  onForget,
}: {
  project: Project;
  on: boolean;
  focused: boolean;
  windowed: boolean;
  onPick: (id: string) => void;
  onOpen: (p: Project) => void;
  onForget: (id: string) => void;
}) {
  return (
    <section
      data-nav={p.id}
      data-selected={on || undefined}
      onClick={() => onPick(p.id)}
      onDoubleClick={() => !p.current && onOpen(p)}
      className={cn("flex min-w-0 cursor-pointer flex-col border px-ch pb-half", on && "border-primary")}
    >
      <h3 className="-mt-half flex justify-between gap-ch">
        <span className={cn("truncate bg-background px-half font-bold", on && focused && "text-primary")}>{p.name}</span>
        {p.current && <span className="flex-none bg-background px-half text-working">● open here</span>}
        {windowed && <span className="flex-none bg-background px-half text-muted-foreground">○ open</span>}
      </h3>
      <dl className="mt-half grid grid-cols-[8ch_1fr] gap-x-ch">
        <Field label="where">{p.where ?? <span className="text-muted-foreground">not on this machine</span>}</Field>
        {p.remote && <Field label="remote">{short(p.remote)}</Field>}
        <Field label="board">{p.board ?? <span className="text-muted-foreground">on this machine</span>}</Field>
      </dl>
      <p className="mt-half flex flex-wrap gap-x-2ch border-t pt-half">
        {!p.current && (
          <Button k="⏎" lit={on} onClick={() => onOpen(p)}>
            open
          </Button>
        )}
        {p.recent && !p.current && (
          <Button k="x" lit={on} onClick={() => onForget(p.id)}>
            forget
          </Button>
        )}
      </p>
    </section>
  );
}
