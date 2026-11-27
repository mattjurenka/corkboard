// Adding a fleet host (corkboard.fleet_host, nvim/lua/corkboard/fleet_host.lua),
// boxed over the page: what `corkboard-fleet device` printed on the host,
// pasted here, then the command that keeps its cert, to copy and run there.
// Esc cancels; a paste with a device in it goes by itself.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { cn } from "@/lib/utils";

// Two keys (lib/e2ee/wire.ts's KEY) that differ: a device's id and its box key.
const whole = (s: string) => new Set(s.split(/[^A-Za-z0-9_-]+/).filter((w) => w.length === 43)).size >= 2;

export function FleetHost() {
  const host = useStore((s) => s.fleetHost);
  const nvim = useNvim();
  const [text, setText] = useState("");
  const [pass, setPass] = useState("");
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const secret = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const step = host?.step;
  const open = !!host;

  // What was pasted is kept through a passphrase asked again, not past a close.
  useEffect(() => {
    if (open) return;
    setText("");
    setPass("");
  }, [open]);
  useEffect(() => {
    if (!host) return;
    setCopied(false);
    if (host.step === "paste") (host.passphrase ? secret : field).current?.focus();
    else box.current?.focus();
  }, [host]);

  if (!host) return null;
  const call = (fn: string, ...args: unknown[]) => void nvim.lua(`require('corkboard.fleet_host').${fn}(...)`, ...args);
  const close = () => {
    store.set({ fleetHost: null });
    call("cancel");
    nvim.refocus();
  };
  const send = (s = text) => {
    if (s.trim()) call("paste", s);
  };
  const copy = () =>
    void navigator.clipboard
      ?.writeText(host.command ?? "")
      .then(() => setCopied(true))
      .catch(() => {});

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (step === "cert" && e.key === "c") {
      e.preventDefault();
      return copy();
    }
    if ((step === "cert" || step === "error") && e.key === "Enter") {
      e.preventDefault();
      close();
    }
  };

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
  const code = "bg-muted px-half";

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60" onMouseDown={close}>
      <div
        ref={box}
        role="dialog"
        aria-label="Add a fleet host"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={keys}
        className="flex w-[min(72ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pt-half pb-half outline-none"
      >
        <p className="text-primary">add a fleet host</p>
        {step === "paste" && host.passphrase ? (
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
              ref={secret}
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="mt-half w-full border bg-muted px-ch outline-none focus:border-primary"
            />
            {host.error && <p className="mt-half break-words text-blocked">{host.error}</p>}
          </form>
        ) : step === "paste" ? (
          <>
            <p className="mt-row">
              On the host (a NixOS machine with corkboard's fleet module), run <span className={code}>corkboard-fleet device</span> and
              paste here what it prints.
            </p>
            <textarea
              ref={field}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const s = e.clipboardData.getData("text");
                if (!whole(s)) return;
                e.preventDefault();
                setText(s);
                send(s);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey) return;
                e.preventDefault();
                e.stopPropagation();
                send();
              }}
              rows={6}
              spellCheck={false}
              aria-label="what corkboard-fleet device printed"
              className="mt-half w-full resize-none border bg-muted px-ch outline-none focus:border-primary"
            />
            {host.error && <p className="mt-half break-words text-blocked">{host.error}</p>}
          </>
        ) : step === "waiting" ? (
          <p className="mt-row text-muted-foreground">signing it in…</p>
        ) : step === "cert" ? (
          <>
            <p className="mt-row">
              {host.name} is certified. Run this on the host to keep its cert, then restart its fleetd
              (<span className={code}>systemctl --user restart corkboard-fleetd</span>):
            </p>
            <pre
              onClick={copy}
              title="copy"
              className="mt-half max-h-[calc(8*var(--spacing-row))] cursor-pointer overflow-y-auto border bg-muted px-ch break-all whitespace-pre-wrap"
            >
              {host.command}
            </pre>
            <p className="mt-half text-muted-foreground">
              Its environment shows in the Fleet tab once fleetd is up. The cert lets it reach this account's node and nothing else;
              it isn't a secret.
            </p>
          </>
        ) : (
          <p className="mt-row break-words text-blocked">{host.error}</p>
        )}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          {step === "cert" ? (
            <>
              {hint("c", copied ? "copied" : "copy", copy)}
              {hint("⏎", "done", close, true)}
            </>
          ) : step === "error" ? (
            hint("⏎", "close", close, true)
          ) : (
            <>
              {hint("esc", "cancel", close)}
              {step === "paste" && !host.passphrase && hint("⏎", "certify", () => send(), true)}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
