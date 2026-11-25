// A machine's first start (bridge/onboarding.ts), before Neovim: a new
// account here, joining one from a device already in it, or recovering one
// from its phrase. The page goes on to start Neovim once done is called.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Join = { code?: string; sas?: string; account?: string; error?: string } | null;
export type AccountCall = (path: string, body?: unknown) => Promise<{ error?: string; account?: string; phrase?: string; join?: Join }>;

type Step = { at: "choose" } | { at: "phrase"; words: string[] } | { at: "join"; join: Join } | { at: "recover" };

const CHOICES = [
  ["create", "make a new account"],
  ["join", "join an account"],
  ["recover", "recover an account"],
] as const;

export function Welcome({ call, done }: { call: AccountCall; done: () => void }) {
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [pick, setPick] = useState(0);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (step.at === "recover") field.current?.focus();
    else box.current?.focus();
  }, [step.at]);

  // The other device's approval comes to the bridge, and from it here.
  const joining = step.at === "join" && !step.join?.account && !step.join?.error;
  useEffect(() => {
    if (!joining) return;
    const t = setInterval(async () => {
      const r = await call("/account").catch(() => undefined);
      if (r?.join) setStep({ at: "join", join: r.join });
    }, 1000);
    return () => clearInterval(t);
  }, [joining, call]);

  const go = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(undefined);
    const r = await call(path, body).catch((e: Error) => ({ error: e.message }) as Awaited<ReturnType<AccountCall>>);
    setBusy(false);
    if (r.error) setError(r.error);
    return r;
  };

  const choose = async (i: number) => {
    const what = CHOICES[i][0];
    if (what === "recover") return setStep({ at: "recover" });
    if (what === "create") {
      const r = await go("/account/create");
      if (r.phrase) setStep({ at: "phrase", words: r.phrase.split(" ") });
      return;
    }
    setStep({ at: "join", join: null });
    const r = await go("/account/join");
    if (r.join) setStep({ at: "join", join: r.join });
  };
  const back = () => {
    if (step.at === "join") void call("/account/join/cancel").catch(() => {});
    setError(undefined);
    setStep({ at: "choose" });
  };
  const recover = async () => {
    const r = await go("/account/recover", { phrase });
    if (r.account) done();
  };
  const answer = async (ok: boolean) => {
    const r = await go("/account/join/confirm", { ok });
    if (r.join) setStep({ at: "join", join: r.join });
  };

  const join = step.at === "join" ? step.join : null;
  const sas = join?.sas && !join.account && !join.error;

  const keys = (e: React.KeyboardEvent) => {
    if (busy) return;
    const k = e.key;
    if (step.at === "choose") {
      const n = Number(k);
      if (n >= 1 && n <= CHOICES.length) void choose(n - 1);
      else if (k === "ArrowDown" || k === "j") setPick((p) => (p + 1) % CHOICES.length);
      else if (k === "ArrowUp" || k === "k") setPick((p) => (p + CHOICES.length - 1) % CHOICES.length);
      else if (k === "Enter") void choose(pick);
      else return;
    } else if (step.at === "phrase") {
      if (k === "Enter") done();
      else return;
    } else if (step.at === "recover") {
      if (k === "Escape") back();
      else if (k === "Enter" && !e.shiftKey) void recover();
      else return;
    } else if (join?.account) {
      if (k === "Enter") done();
      else return;
    } else if (sas) {
      if (k === "Enter" || k === "y") void answer(true);
      else if (k === "n") void answer(false);
      else if (k === "Escape") back();
      else return;
    } else if (k === "Escape" || (join?.error && k === "Enter")) back();
    else return;
    e.preventDefault();
  };

  const hint = (k: string, what: string, act: () => void, main = false) => (
    <button
      type="button"
      onClick={act}
      disabled={busy}
      className={cn("cursor-pointer px-half", main ? "bg-primary font-bold text-primary-foreground" : "hover:bg-accent")}
    >
      {main ? (
        `${k} ${what}`
      ) : (
        <>
          <span className="text-primary">{k}</span> {what}
        </>
      )}
    </button>
  );

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background font-mono text-foreground">
      <div
        ref={box}
        role="dialog"
        aria-label="corkboard"
        tabIndex={-1}
        onKeyDown={keys}
        className="flex w-[min(60ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pt-half pb-half outline-none"
      >
        <p className="text-primary">corkboard</p>
        {step.at === "choose" ? (
          <ol className="mt-row">
            {CHOICES.map(([, label], i) => (
              <li key={label}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void choose(i)}
                  onMouseEnter={() => setPick(i)}
                  className={cn("w-full cursor-pointer px-ch text-left", i === pick && "bg-selection")}
                >
                  <span className="text-primary">{i + 1}</span> {label}
                </button>
              </li>
            ))}
          </ol>
        ) : step.at === "phrase" ? (
          <>
            <p className="mt-row">recovery phrase</p>
            <ol className="mt-half grid grid-cols-2 gap-x-2ch sm:grid-cols-4">
              {step.words.map((w, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">{String(i + 1).padStart(2)}.</span> {w}
                </li>
              ))}
            </ol>
          </>
        ) : step.at === "recover" ? (
          <>
            <p className="mt-row">recovery phrase</p>
            <textarea
              ref={field}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              aria-label="recovery phrase"
              className="mt-half w-full resize-none border bg-muted px-ch outline-none focus:border-primary"
            />
          </>
        ) : join?.account ? (
          <p className="mt-row">This machine is in.</p>
        ) : sas ? (
          <>
            <p className="mt-row text-center text-large font-bold tracking-[0.3ch] text-primary">{`${join.sas!.slice(0, 3)} ${join.sas!.slice(3)}`}</p>
            <p className="mt-half text-center">Does the other device show the same?</p>
          </>
        ) : join?.code ? (
          <>
            <p className="mt-row">On a device in the account, Pair a device:</p>
            <p className="mt-half text-center text-large font-bold tracking-[0.3ch] text-primary">{join.code}</p>
            <p className="mt-half text-center text-muted-foreground">waiting…</p>
          </>
        ) : !join?.error ? (
          <p className="mt-row text-muted-foreground">…</p>
        ) : null}
        {(error ?? join?.error) && <p className="mt-half break-words text-blocked">{error ?? join?.error}</p>}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          {step.at === "choose" ? (
            hint("⏎", "choose", () => void choose(pick), true)
          ) : step.at === "phrase" ? (
            hint("⏎", "written down", done, true)
          ) : step.at === "recover" ? (
            <>
              {hint("esc", "back", back)}
              {hint("⏎", "recover", () => void recover(), true)}
            </>
          ) : join?.account ? (
            hint("⏎", "start", done, true)
          ) : sas ? (
            <>
              {hint("esc", "back", back)}
              {hint("n", "no", () => void answer(false))}
              {hint("⏎", "they match", () => void answer(true), true)}
            </>
          ) : (
            hint("esc", "back", back)
          )}
        </p>
      </div>
    </div>
  );
}
