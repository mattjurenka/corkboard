// A question from Neovim (corkboard.ask), boxed over the page: the question,
// and a field for the answer (vim.ui.input) or its choices (vim.ui.select).
// Enter answers, Shift+Enter starts a new line, Esc cancels; a choice goes
// by click, its number, or j/k and Enter.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { cn } from "@/lib/utils";

export function Ask() {
  const ask = useStore((s) => s.ask);
  const nvim = useNvim();
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLFormElement>(null);
  const secret = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ask) return;
    setText(ask.default);
    setAt(0);
    if (ask.choices) return list.current?.focus();
    if (ask.secret) return secret.current?.focus();
    const f = field.current;
    f?.focus();
    f?.setSelectionRange(ask.default.length, ask.default.length);
  }, [ask]);

  if (!ask) return null;
  const choices = ask.choices;
  const reply = (answer: string | number | null) => {
    store.set({ ask: null });
    void nvim.lua("require('corkboard.ask').reply(...)", ask.id, answer);
    nvim.refocus();
  };
  const answer = () => reply(choices ? at + 1 : text);

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return reply(null);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      return answer();
    }
    if (!choices) return;
    const n = Number(e.key);
    if (n >= 1 && n <= choices.length) {
      e.preventDefault();
      return reply(n);
    }
    const down = e.key === "ArrowDown" || e.key === "j" || e.key === "Tab";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (!down && !up) return;
    e.preventDefault();
    setAt((a) => Math.max(0, Math.min(choices.length - 1, a + (down ? 1 : -1))));
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60" onMouseDown={() => reply(null)}>
      <form
        ref={list}
        role="dialog"
        aria-label={ask.prompt}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          answer();
        }}
        onKeyDown={keys}
        className="flex max-h-[calc(100%-2*var(--spacing-row))] w-[min(72ch,calc(100%-2ch))] flex-col border border-primary bg-background px-2ch pt-half pb-half outline-none"
      >
        {ask.prompt && <p className="overflow-y-auto break-words whitespace-pre-wrap">{ask.prompt}</p>}
        {choices ? (
          <ul className="mt-half flex-none overflow-y-auto">
            {choices.map((c, i) => (
              <li
                key={i}
                onMouseEnter={() => setAt(i)}
                onClick={() => reply(i + 1)}
                className={cn("flex cursor-pointer gap-ch px-ch", i === at && "bg-selection")}
              >
                <span className="text-primary">{i + 1}</span>
                <span className="min-w-0 break-words">{c}</span>
              </li>
            ))}
          </ul>
        ) : ask.secret ? (
          <input
            ref={secret}
            type="password"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mt-half min-w-0 flex-none border bg-muted px-ch outline-none focus:border-primary"
          />
        ) : (
          <textarea
            ref={field}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            spellCheck={false}
            className="mt-half min-w-0 flex-none resize-none border bg-muted px-ch outline-none focus:border-primary"
          />
        )}
        <p className="mt-half flex flex-wrap items-baseline justify-end gap-x-2ch border-t pt-half">
          <button type="button" onClick={() => reply(null)} className="cursor-pointer px-half hover:bg-accent">
            <span className="text-primary">esc</span> cancel
          </button>
          <button type="submit" className="cursor-pointer bg-primary px-half font-bold text-primary-foreground">
            ⏎ {choices ? "pick" : "ok"}
          </button>
        </p>
      </form>
    </div>
  );
}
