// Pairing a device (corkboard.pair, nvim/lua/corkboard/pair.lua), boxed over
// the page: the ten-character code the new device shows, typed into its
// cells, then its six digits checked against these. Esc cancels; the code
// goes by itself once it's all there.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { cn } from "@/lib/utils";

const LEN = 10;

// As lib/e2ee/wire.ts's normalizeCode reads it, a character at a time:
// O is 0, I and L are 1, and what isn't Crockford's (U, a dash) goes.
const clean = (s: string) =>
  s
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
    .slice(0, LEN);

export function Pair() {
  const pair = useStore((s) => s.pair);
  const nvim = useNvim();
  const [code, setCode] = useState("");
  const [pass, setPass] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const step = pair?.step;

  useEffect(() => {
    if (!pair) return;
    if (pair.step === "code") {
      setCode("");
      field.current?.focus();
    } else box.current?.focus();
  }, [pair]);

  if (!pair) return null;
  const call = (fn: string, ...args: unknown[]) => void nvim.lua(`require('corkboard.pair').${fn}(...)`, ...args);
  const close = () => {
    store.set({ pair: null });
    call("cancel");
    nvim.refocus();
  };
  const type = (s: string) => {
    const c = clean(s);
    setCode(c);
    if (c.length === LEN) call("code", c);
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (step === "sas") {
      if (e.key === "Enter" || e.key === "y") call("answer", true);
      else if (e.key === "n") call("answer", false);
      else return;
      return e.preventDefault();
    }
    if ((step === "done" || step === "error") && e.key === "Enter") {
      e.preventDefault();
      close();
    }
  };

  const sas = pair.sas ? `${pair.sas.slice(0, 3)} ${pair.sas.slice(3)}` : "";
  const hint = (k: string, what: string, go: () => void, main = false) => (
    <button
      type="button"
      onClick={go}
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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60" onMouseDown={close}>
      <div
        ref={box}
        role="dialog"
        aria-label="Pair a device"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={keys}
        className="flex w-[min(44ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pt-half pb-half outline-none"
      >
        <p className="text-primary">pair a device</p>
        {step === "code" && pair.passphrase ? (
          <form
            className="mt-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (pass) call("passphrase", pass);
              setPass("");
            }}
          >
            <p>passphrase</p>
            <input
              ref={field}
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="mt-half w-full border bg-muted px-ch outline-none focus:border-primary"
            />
          </form>
        ) : step === "code" ? (
          <>
            <p className="mt-row">the code on the new device</p>
            <label className="relative mt-half flex justify-center gap-ch">
              {Array.from({ length: LEN }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "flex h-[calc(2*var(--spacing-row))] w-[3ch] items-center justify-center border text-large",
                    i === 5 && "ml-2ch",
                    i === code.length && "border-primary bg-selection",
                  )}
                >
                  {code[i] ?? ""}
                </span>
              ))}
              <input
                ref={field}
                value={code}
                onChange={(e) => type(e.target.value)}
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                maxLength={LEN + 2}
                aria-label="code"
                className="absolute inset-0 cursor-default opacity-0"
              />
            </label>
            {pair.error && <p className="mt-half break-words text-blocked">{pair.error}</p>}
          </>
        ) : step === "waiting" ? (
          <p className="mt-row text-muted-foreground">
            {pair.confirming ? `letting ${pair.name} in…` : `waiting for the device…`}
          </p>
        ) : step === "sas" ? (
          <>
            <p className="mt-row text-center text-large font-bold tracking-[0.3ch] text-primary">{sas}</p>
            <p className="mt-half text-center">Does {pair.name} show the same?</p>
          </>
        ) : step === "done" ? (
          <p className="mt-row">{pair.refused ? `${pair.name} was turned away.` : `${pair.name} is in.`}</p>
        ) : (
          <p className="mt-row break-words text-blocked">{pair.error}</p>
        )}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          {step === "sas" ? (
            <>
              {hint("esc", "cancel", close)}
              {hint("n", "no", () => call("answer", false))}
              {hint("⏎", "they match", () => call("answer", true), true)}
            </>
          ) : step === "done" || step === "error" ? (
            hint("⏎", "close", close, true)
          ) : (
            hint("esc", "cancel", close)
          )}
        </p>
      </div>
    </div>
  );
}
