// The tool picker (Ctrl+Space or Alt+Space, corkboard.picker.tools), as a
// window of the page's rather than a float on the grid: a title bar, a search
// field and the tools under it, each with its key. The one chosen runs in
// Neovim (corkboard.picker.run), in the window the picker was opened from.
// Unlike the rest of the page this is a desktop dialog, though in the
// editor's face and colors.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";

const NAMED: Record<string, string> = { C: "Ctrl", A: "Alt", M: "Alt", S: "Shift", D: "Cmd" };

// "<C-f>" to Ctrl F, "<leader>c" to the leader then C, "F5" as it is.
function keys(hint: string, leader: string): string[] {
  if (!hint.includes("<")) return [hint];
  const out: string[] = [];
  for (const [, special, plain] of hint.matchAll(/<([^>]+)>|(.)/g)) {
    if (plain) out.push(plain.toUpperCase());
    else if (special.toLowerCase() === "leader") out.push(leader);
    else {
      const parts = special.split("-");
      const key = parts.pop()!;
      out.push(...parts.map((m) => NAMED[m.toUpperCase()] ?? m), key.length === 1 ? key.toUpperCase() : key);
    }
  }
  return out;
}

// Every letter of the query in order, as snacks matches.
const matches = (text: string, query: string) => {
  let at = 0;
  for (const c of query.toLowerCase()) {
    at = text.toLowerCase().indexOf(c, at) + 1;
    if (!at) return false;
  }
  return true;
};

export function Tools() {
  const open = useStore((s) => s.tools);
  const nvim = useNvim();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPicked(0);
    input.current?.focus();
  }, [open]);

  if (!open) return null;
  const shown = open.tools.map((tool, i) => ({ ...tool, i })).filter((t) => matches(t.text, query));
  const at = Math.min(picked, shown.length - 1);

  const close = () => {
    store.set({ tools: null });
    nvim.refocus();
  };
  const choose = (i: number) => {
    close();
    nvim.lua("require('corkboard.picker').run(...)", i + 1);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const down = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"));
    const up = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"));
    if (down || up) {
      e.preventDefault();
      setPicked(Math.max(0, Math.min(shown.length - 1, at + (down ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[at]) choose(shown[at].i);
    } else if (e.key === "Escape" || ((e.ctrlKey || e.altKey) && e.key === " ")) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="fixed inset-0 z-10 bg-black/25" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Open"
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-[18%] left-1/2 w-[min(440px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-[10px] border bg-popover text-popover-foreground shadow-[0_12px_40px_rgb(0_0_0/0.45),0_2px_8px_rgb(0_0_0/0.25)] select-none"
      >
        <div className="flex h-[34px] items-center justify-between border-b bg-muted pr-[6px] pl-[12px]">
          <span className="font-semibold">Open</span>
          <button
            type="button"
            title="Close (Esc)"
            onClick={close}
            className="grid size-[22px] place-items-center rounded-[5px] text-muted-foreground hover:bg-border hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" className="size-[10px]" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>
        <div className="p-[10px] pb-[6px]">
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search tools"
            spellCheck={false}
            className="h-[32px] w-full rounded-[6px] border bg-background px-[10px] outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/25"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto px-[6px] pb-[6px]">
          {shown.map((tool, n) => (
            <li
              key={tool.i}
              onMouseMove={() => n !== at && setPicked(n)}
              onClick={() => choose(tool.i)}
              className={cn(
                "flex h-[32px] cursor-default items-center justify-between gap-[12px] rounded-[6px] px-[10px]",
                n === at && "bg-selection",
              )}
            >
              <span className="truncate">{tool.text}</span>
              {tool.hint && (
                <span className="flex shrink-0 gap-[3px]">
                  {keys(tool.hint, open.leader).map((k, j) => (
                    <kbd key={j} className="min-w-[20px] rounded-[4px] border bg-muted px-[5px] text-center text-muted-foreground">
                      {k}
                    </kbd>
                  ))}
                </span>
              )}
            </li>
          ))}
          {!shown.length && <li className="px-[10px] py-[7px] text-muted-foreground">No tools match</li>}
        </ul>
      </div>
    </div>
  );
}
