// A brain's form (corkboard.brains, a or e on the Brains view), boxed over
// the page: its title, what it's for, and the rest picked rather than typed.
// The account and what it holds are tags from the live brains', or one
// added; a new brain names itself from its title and may start from another,
// taking its account, what it holds, its abilities and its persona. The
// persona is who its sessions' avatar is. Saved in Neovim
// (corkboard.brains.save); a stale change gets the brain as it is now.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { type BrainFields, store, useStore } from "@/store";
import { cn } from "@/lib/utils";
import { PERSONAS } from "@/avatar/personas";

type Draft = Omit<BrainFields, "updated">;

// The avatar's skin tones; none is the model's own.
const SKINS = { porcelain: "#f7e1d3", fair: "#efc9ad", light: "#e0ac87", tan: "#c68a5e", brown: "#9a6440", deep: "#5e3b26" };
const BLANK: Draft = { name: "", title: "", description: "", account: null, credentials: [], abilities: [], persona: null, skin: null, default: false };
const LABEL = /^[\w.-]{1,64}$/;

// A title as a name: lowercase, dashes, starting with a letter, at most 32.
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

export function BrainForm() {
  const open = useStore((s) => s.brainForm);
  const nvim = useNvim();
  const [base, setBase] = useState<BrainFields | undefined>();
  const [d, setD] = useState<Draft>(BLANK);
  const [from, setFrom] = useState<string | null>(null);
  const [named, setNamed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setBase(open.brain);
    setD(open.brain ?? BLANK);
    setFrom(null);
    setNamed(false);
    setProblem(null);
    title.current?.focus();
  }, [open]);

  if (!open) return null;
  const set = (f: Partial<Draft>) => setD((x) => ({ ...x, ...f }));
  const accounts = uniq([...open.brains.map((b) => b.account), d.account]);
  const labels = uniq([...open.brains.flatMap((b) => b.credentials), ...d.credentials]);
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  const close = () => {
    store.set({ brainForm: null });
    nvim.refocus();
  };
  const start = (b: BrainFields | null) => {
    setFrom(b?.name ?? null);
    set({ account: b?.account ?? null, credentials: b?.credentials ?? [], abilities: b?.abilities ?? [], persona: b?.persona ?? null, skin: b?.skin ?? null });
  };
  const save = async () => {
    if (busy || !d.title.trim() || (!base && !d.name)) return;
    setBusy(true);
    const { name: _, ...fields } = d;
    const res = await nvim.lua("return require('corkboard.brains').save(...)", base?.name ?? null, base?.updated ?? null, base ? fields : d);
    setBusy(false);
    if (res?.name) return close();
    if (res?.stale) {
      setBase(res.stale);
      setD(res.stale);
    }
    setProblem(res?.problem ?? "couldn't save it");
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60">
      <form
        role="dialog"
        aria-label={base ? `edit ${base.title}` : "new brain"}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
        className="flex max-h-[calc(100%-2*var(--spacing-row))] w-[min(84ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pb-half"
      >
        <h2 className="-mt-half flex">
          <span className="bg-background px-half">
            {base ? (
              <>
                <span className="font-bold text-primary">edit</span> <span className="font-bold">{base.title}</span>
                {base.name !== base.title.toLowerCase() && <span className="text-muted-foreground"> {base.name}</span>}
              </>
            ) : (
              <span className="font-bold text-primary">new brain</span>
            )}
          </span>
        </h2>

        <div className={cn("grid min-h-0 overflow-y-auto pt-half", !base && open.brains.length > 0 && "grid-cols-[22ch_1fr] gap-x-2ch max-[800px]:grid-cols-1")}>
          {!base && open.brains.length > 0 && (
            <fieldset className="flex flex-col border-r pr-ch max-[800px]:border-r-0 max-[800px]:pb-row">
              <legend className="text-muted-foreground">start from</legend>
              <Start on={from === null} onClick={() => start(null)}>
                blank
              </Start>
              {open.brains.map((b) => (
                <Start key={b.name} on={from === b.name} onClick={() => start(b)}>
                  like {b.title}
                </Start>
              ))}
            </fieldset>
          )}

          <div className="grid grid-cols-[9ch_1fr] items-start gap-x-ch gap-y-row">
            <label htmlFor="brain-title" className="text-muted-foreground">
              title
            </label>
            <input
              id="brain-title"
              ref={title}
              value={d.title}
              onChange={(e) => set(base || named ? { title: e.target.value } : { title: e.target.value, name: slug(e.target.value) })}
              autoComplete="off"
              className="min-w-0 border-b border-primary bg-muted px-ch outline-none"
            />

            {!base && (
              <>
                <label htmlFor="brain-name" className="text-muted-foreground">
                  name
                </label>
                <input
                  id="brain-name"
                  value={d.name}
                  onChange={(e) => {
                    setNamed(true);
                    set({ name: e.target.value.toLowerCase() });
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 border-b bg-transparent px-ch text-muted-foreground outline-none focus:border-primary focus:text-foreground"
                />
              </>
            )}

            <label htmlFor="brain-about" className="text-muted-foreground">
              about
            </label>
            <textarea
              id="brain-about"
              value={d.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              className="min-w-0 resize-none border bg-muted px-ch outline-none focus:border-primary"
            />

            <span className="text-muted-foreground">runs as</span>
            <div className="flex flex-wrap gap-ch">
              {accounts.map((a) => (
                <Tag key={a} on={d.account === a} mark={d.account === a ? "●" : "○"} onClick={() => set({ account: a })}>
                  {a}
                </Tag>
              ))}
              <Tag on={d.account === null} mark={d.account === null ? "●" : "○"} onClick={() => set({ account: null })}>
                machine default
              </Tag>
              <Add what="account" onAdd={(a) => set({ account: a })} />
            </div>

            <span className="text-muted-foreground">holds</span>
            <div className="flex flex-col">
              <div className="flex flex-wrap gap-ch">
                {labels.map((l) => {
                  const on = d.credentials.includes(l);
                  return (
                    <Tag key={l} on={on} mark={on ? "✓" : "+"} onClick={() => set({ credentials: toggle(d.credentials, l) })}>
                      {l}
                    </Tag>
                  );
                })}
                <Add what="label" onAdd={(l) => set({ credentials: d.credentials.includes(l) ? d.credentials : [...d.credentials, l] })} />
              </div>
              {d.credentials.length > 0 && <span className="text-review">agents need your OK to spawn it</span>}
            </div>

            <span className="text-muted-foreground">persona</span>
            <div className="flex flex-wrap items-end gap-ch">
              {open.personas.map((p) => (
                <Portrait key={p} id={p} on={d.persona === p} onClick={() => set({ persona: p })} />
              ))}
              <Tag on={!d.persona} mark={!d.persona ? "●" : "○"} onClick={() => set({ persona: null })}>
                default
              </Tag>
            </div>

            <span className="text-muted-foreground">skin</span>
            <div className="flex flex-wrap gap-x-2ch gap-y-half">
              <Tag on={!d.skin} mark={!d.skin ? "●" : "○"} onClick={() => set({ skin: null })}>
                as made
              </Tag>
              {Object.entries(SKINS).map(([name, hex]) => (
                <Tag key={hex} on={d.skin === hex} mark={d.skin === hex ? "●" : "○"} onClick={() => set({ skin: hex })}>
                  <span style={{ color: hex }}>██</span> {name}
                </Tag>
              ))}
            </div>

            <span className="text-muted-foreground">can</span>
            <div className="flex flex-wrap gap-x-2ch">
              {open.abilities.map((a) => (
                <Check key={a} on={d.abilities.includes(a)} onClick={() => set({ abilities: toggle(d.abilities, a) })}>
                  {a}
                </Check>
              ))}
              <Check on={d.default} onClick={() => set({ default: !d.default })}>
                default
              </Check>
            </div>
          </div>
        </div>

        {problem && <p className="pt-half break-words text-destructive">{problem}</p>}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          <span>
            <span className="text-primary">tab</span> next
          </span>
          <span>
            <span className="text-primary">space</span> toggle
          </span>
          <button type="button" onClick={close} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">esc</span> cancel
          </button>
          <button
            type="submit"
            disabled={busy || !d.title.trim() || (!base && !d.name)}
            className="cursor-pointer bg-primary px-half font-bold text-primary-foreground disabled:cursor-default disabled:opacity-50"
          >
            {busy ? "…" : base ? "⏎ save" : "⏎ make it"}
          </button>
        </p>
      </form>
    </div>
  );
}

// A tag, lit when it's picked.
// A persona as its portrait (public/personas, bun run portraits) over its name.
function Portrait({ id, on, onClick }: { id: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("flex w-[17ch] cursor-pointer flex-col border outline-none focus-visible:border-primary", on ? "border-primary bg-primary/20" : "text-muted-foreground hover:text-foreground")}
    >
      <img src={`personas/${id}.png`} alt="" draggable={false} className={cn("aspect-[4/5] w-full object-cover object-top", !on && "opacity-70")} />
      <span className="truncate border-t px-ch text-left">
        {on ? "●" : "○"} {(PERSONAS as Record<string, { title: string }>)[id]?.title.toLowerCase() ?? id}
      </span>
    </button>
  );
}

function Tag({ on, mark, onClick, children }: { on: boolean; mark: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("cursor-pointer border px-ch outline-none focus-visible:border-primary", on ? "border-primary bg-primary/20" : "text-muted-foreground hover:text-foreground")}
    >
      {mark} {children}
    </button>
  );
}

// + what, which turns into a field for one; ⏎ adds it, esc leaves it.
function Add({ what, onAdd }: { what: string; onAdd: (v: string) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  if (typing === null)
    return (
      <button
        type="button"
        onClick={() => setTyping("")}
        className="cursor-pointer border border-dashed px-ch text-muted-foreground outline-none hover:text-foreground focus-visible:border-primary"
      >
        + {what}
      </button>
    );
  const ok = LABEL.test(typing.trim());
  return (
    <input
      autoFocus
      aria-label={`new ${what}`}
      value={typing}
      onChange={(e) => setTyping(e.target.value)}
      onBlur={() => setTyping(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (ok) onAdd(typing.trim());
          setTyping(null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setTyping(null);
        }
      }}
      autoComplete="off"
      spellCheck={false}
      className={cn("w-[16ch] border bg-muted px-ch outline-none", ok || !typing ? "border-primary" : "border-destructive")}
    />
  );
}

// [x] or [ ] and what it is.
function Check({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onClick} className="cursor-pointer outline-none hover:text-primary focus-visible:text-primary">
      {on ? "[x]" : "[ ]"} {children}
    </button>
  );
}

// One brain to start a new one from, ▸ when it's the one.
function Start({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("cursor-pointer px-ch text-left outline-none focus-visible:text-primary", on ? "bg-primary/20" : "text-muted-foreground hover:text-foreground")}
    >
      <span className="text-primary">{on ? "▸" : " "}</span> {children}
    </button>
  );
}
