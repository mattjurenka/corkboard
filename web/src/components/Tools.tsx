// The tool picker (Ctrl+Space or Alt+Space, corkboard.picker.tools), as a
// window of the page's rather than a float on the grid: a title bar, a search
// field and the tools under it, each with its key. The one chosen runs in
// Neovim (corkboard.picker.run), in the window the picker was opened from.

import { useEffect, useRef, useState } from "react";
import { useNvim } from "@/nvim/context";
import { store, useStore } from "@/store";
import { Palette, Row, Search, matches, step } from "./Palette";

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
    const moved = step(e, at, shown.length);
    if (moved !== null) setPicked(moved);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[at]) choose(shown[at].i);
    } else if (e.key === "Escape" || ((e.ctrlKey || e.altKey) && e.key === " ")) {
      e.preventDefault();
      close();
    }
  };

  return (
    <Palette title="Open" onClose={close}>
      <Search
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search tools"
      />
      <ul className="max-h-[50vh] overflow-y-auto px-[6px] pb-[6px]">
        {shown.map((tool, n) => (
          <Row key={tool.i} picked={n === at} onMouseMove={() => n !== at && setPicked(n)} onClick={() => choose(tool.i)}>
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
          </Row>
        ))}
        {!shown.length && <li className="px-[10px] py-[7px] text-muted-foreground">No tools match</li>}
      </ul>
    </Palette>
  );
}
