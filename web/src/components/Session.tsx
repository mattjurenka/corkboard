// The session picker (Ctrl+. or the board's A; corkboard.session's pick), as
// a window of the page's rather than a float on the grid: columns, a choice
// in each, and to its right what that choice offers, which follows it. j/k
// or the arrows move in a column; l, →, Tab or Enter go right, h, ← or
// Shift+Tab back; Enter on a choice that offers nothing more runs it in
// Neovim (corkboard.session.run). A click chooses there and goes right, or
// runs it. It opens on the last choice made.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { store, useStore, type SessionItem, type SessionPick } from "@/store";
import { Palette, Row, step } from "./Palette";

// How many columns the items may fill; one that offers nothing still has
// its (empty) column.
const depth = (items: SessionItem[]): number => 1 + Math.max(0, ...items.map((it) => (it.items ? depth(it.items) : 0)));

// What column k shows, from the choices left of it; none past a leaf.
function column(items: SessionItem[], sel: number[], k: number): SessionItem[] | undefined {
  let list: SessionItem[] | undefined = items;
  for (let j = 0; j < k && list; j++) list = list[sel[j] ?? 0]?.items;
  return list;
}

// The last choice, as far as it's still offered: the row in each column,
// and the column it ends in.
function start(pick: SessionPick): { sel: number[]; at: number } {
  const sel: number[] = [];
  let at = 0;
  for (const [k, text] of (pick.last ?? []).entries()) {
    const found = column(pick.items, sel, k)?.findIndex((it) => it.text === text) ?? -1;
    if (found < 0) break;
    sel[k] = found;
    at = k;
  }
  return { sel, at };
}

export function Session() {
  const open = useStore((s) => s.session);
  return open && <Columns pick={open} />;
}

function Columns({ pick }: { pick: SessionPick }) {
  const nvim = useNvim();
  // The row chosen in each column, and the column the keys are in.
  const [{ sel, at }, set] = useState(() => start(pick));
  const root = useRef<HTMLDivElement>(null);
  const n = depth(pick.items);

  useEffect(() => root.current?.focus(), []);
  useEffect(() => {
    for (const row of root.current?.querySelectorAll("[data-selected]") ?? []) row.scrollIntoView?.({ block: "nearest" });
  }, [sel, at]);

  const close = () => {
    store.set({ session: null });
    nvim.refocus();
  };
  const run = (it: SessionItem) => {
    close();
    void nvim.lua("require('corkboard.session').run(...)", it.id);
  };
  // Row i of column k chosen, what's right of it back at its first.
  const choose = (k: number, i: number) => [...Array.from({ length: k }, (_, j) => sel[j] ?? 0), i];
  const move = (i: number) => set({ sel: choose(at, i), at });
  // Into what the choice offers, or run it when it offers nothing more.
  const right = () => {
    const it = column(pick.items, sel, at)?.[sel[at] ?? 0];
    if (it?.items?.length) set({ sel, at: at + 1 });
    else if (it?.id != null) run(it);
  };
  const back = () => set({ sel, at: Math.max(0, at - 1) });
  const click = (k: number, i: number, it: SessionItem) => {
    if (it.id != null) return run(it);
    set({ sel: choose(k, i), at: it.items?.length ? k + 1 : k });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const count = column(pick.items, sel, at)?.length ?? 0;
    const moved = step(e, sel[at] ?? 0, count);
    if (moved !== null) return move(moved);
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const does = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (plain && e.key === "j") does(() => move(Math.min(count - 1, (sel[at] ?? 0) + 1)));
    else if (plain && e.key === "k") does(() => move(Math.max(0, (sel[at] ?? 0) - 1)));
    else if (plain && (e.key === "h" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey))) does(back);
    else if (plain && (e.key === "l" || e.key === "ArrowRight" || e.key === "Tab" || e.key === "Enter")) does(right);
    // Esc, or the key that opened it.
    else if (e.key === "Escape" || (plain && e.key === "q") || (e.ctrlKey && e.key === ".")) does(close);
  };

  return (
    <Palette title={pick.title} onClose={close} className="w-[min(760px,calc(100%-32px))]">
      <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} className="flex outline-none">
        {Array.from({ length: n }, (_, k) => {
          const list = column(pick.items, sel, k);
          return (
            <ul
              key={k}
              className={cn("h-[min(50vh,264px)] min-w-0 overflow-y-auto p-[6px]", k > 0 && "border-l", k < n - 1 ? "w-[24%] flex-none" : "flex-1")}
            >
              {list?.map((it, i) => {
                const chosen = k <= at && i === (sel[k] ?? 0);
                return (
                  <Row
                    key={i}
                    picked={chosen && k === at}
                    data-selected={chosen || undefined}
                    aria-selected={chosen}
                    onClick={() => click(k, i, it)}
                    className={cn(chosen && k < at && "bg-muted")}
                  >
                    <span className={cn("truncate", it.detail && "max-w-[70%] flex-none")}>{it.text}</span>
                    {it.detail && <span className="min-w-0 truncate text-muted-foreground">{it.detail}</span>}
                    {it.items && !it.detail && <span className="text-muted-foreground">›</span>}
                  </Row>
                );
              })}
              {list?.length === 0 && <li className="px-[10px] py-[7px] text-muted-foreground">—</li>}
            </ul>
          );
        })}
      </div>
    </Palette>
  );
}
