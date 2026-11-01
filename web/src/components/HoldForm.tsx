// A hold's form (corkboard.holds, a or e on the Holds view), boxed over the
// page: its name, what it's for, where its secret is kept, and the secret,
// typed unseen and never shown back. Forgetting the secret is at once.
// Saved in Neovim (corkboard.holds.save); a stale change gets the hold as it
// is now. A name a template holds is its Nix config's, so it stays.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { type HoldFields, store, useStore } from "@/store";
import { cn } from "@/lib/utils";

type Draft = { name: string; about: string; where: string; secret: string };

const LABEL = /^[\w.-]{1,64}$/;
const draft = (h: HoldFields | null): Draft => ({ name: h?.name ?? "", about: h?.about ?? "", where: h?.where ?? "", secret: "" });

export function HoldForm() {
  const open = useStore((s) => s.holdForm);
  const nvim = useNvim();
  const [base, setBase] = useState<HoldFields | null>(null);
  const [d, setD] = useState<Draft>(draft(null));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const about = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setBase(open.hold);
    setD(draft(open.hold));
    setProblem(null);
    (open.hold?.templates.length ? about.current : first.current)?.focus();
  }, [open]);

  if (!open) return null;
  const set = (f: Partial<Draft>) => setD((x) => ({ ...x, ...f }));
  const fixed = !!base?.templates.length;
  const ok = LABEL.test(d.name);

  const close = () => {
    store.set({ holdForm: null });
    nvim.refocus();
  };
  const stale = (res: any) => {
    setBase(res.stale);
    setD({ ...draft(res.stale), secret: d.secret });
    setProblem(res.problem);
  };
  const save = async () => {
    if (busy || !ok) return;
    setBusy(true);
    const f = { name: d.name, about: d.about, where: d.where, ...(d.secret && { secret: d.secret }) };
    const res = await nvim.lua("return require('corkboard.holds').save(...)", base, f);
    setBusy(false);
    if (res?.name) return close();
    if (res?.stale) return stale(res);
    setProblem(res?.problem ?? "couldn't save it");
  };
  const forget = async () => {
    if (busy || !base) return;
    setBusy(true);
    const res = await nvim.lua("return require('corkboard.holds').forget_now(...)", base.name, base.updated);
    setBusy(false);
    if (res?.hold) {
      setBase(res.hold);
      setProblem(null);
    } else if (res?.stale) stale(res);
    else setProblem(res?.problem ?? "couldn't forget it");
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60">
      <form
        role="dialog"
        aria-label={base ? `edit ${base.name}` : "new hold"}
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
        className="flex max-h-[calc(100%-2*var(--spacing-row))] w-[min(72ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pb-half"
      >
        <h2 className="-mt-half flex">
          <span className="bg-background px-half">
            {base ? (
              <>
                <span className="font-bold text-primary">edit</span> <span className="font-bold">{base.name}</span>
                {!base.recorded && <span className="text-muted-foreground"> no record</span>}
              </>
            ) : (
              <span className="font-bold text-primary">new hold</span>
            )}
          </span>
        </h2>

        <div className="grid min-h-0 grid-cols-[8ch_1fr] items-start gap-x-ch gap-y-row overflow-y-auto pt-half">
          <label htmlFor="hold-name" className="text-muted-foreground">
            name
          </label>
          <span className="flex min-w-0 gap-ch">
            <input
              id="hold-name"
              ref={first}
              value={d.name}
              readOnly={fixed}
              onChange={(e) => set({ name: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "min-w-0 flex-1 border-b bg-muted px-ch outline-none",
                fixed ? "text-muted-foreground" : ok || !d.name ? "border-primary" : "border-destructive",
              )}
            />
            {fixed && <span className="flex-none text-special">nix</span>}
          </span>

          <label htmlFor="hold-about" className="text-muted-foreground">
            about
          </label>
          <textarea
            id="hold-about"
            ref={about}
            value={d.about}
            onChange={(e) => set({ about: e.target.value })}
            rows={3}
            className="min-w-0 resize-none border bg-muted px-ch outline-none focus:border-primary"
          />

          <label htmlFor="hold-where" className="text-muted-foreground">
            where
          </label>
          <input
            id="hold-where"
            value={d.where}
            onChange={(e) => set({ where: e.target.value })}
            autoComplete="off"
            className="min-w-0 border-b bg-muted px-ch outline-none focus:border-primary"
          />

          <label htmlFor="hold-secret" className="text-muted-foreground">
            secret
          </label>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2ch">
            <input
              id="hold-secret"
              type="password"
              value={d.secret}
              onChange={(e) => set({ secret: e.target.value })}
              autoComplete="new-password"
              placeholder={base?.secret ? "••••••••" : ""}
              className="min-w-0 flex-1 border-b bg-muted px-ch outline-none focus:border-primary"
            />
            {base?.secret && (
              <>
                <span className="text-muted-foreground">set {base.secret}</span>
                <button type="button" onClick={() => void forget()} className="cursor-pointer px-half text-destructive hover:bg-accent">
                  forget
                </button>
              </>
            )}
          </span>
        </div>

        {problem && <p className="pt-half break-words text-destructive">{problem}</p>}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          <span>
            <span className="text-primary">tab</span> next
          </span>
          <button type="button" onClick={close} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">esc</span> cancel
          </button>
          <button
            type="submit"
            disabled={busy || !ok}
            className="cursor-pointer bg-primary px-half font-bold text-primary-foreground disabled:cursor-default disabled:opacity-50"
          >
            {busy ? "…" : base ? "⏎ save" : "⏎ make it"}
          </button>
        </p>
      </form>
    </div>
  );
}
