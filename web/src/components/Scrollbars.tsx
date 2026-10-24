// A scrollbar on the right edge of each window of text, from
// corkboard.scroll. Neovim owns the scrolling: the thumb is drawn from where
// the window is, and dragging it or clicking the track asks Neovim to move
// there (corkboard.scroll_to), which then sends the new position back. The
// wheel passes through to the canvas, which scrolls as it always has.
//
// Each bar covers the window's last column and is clipped around floats
// like a panel, so a picker over it is not drawn through.

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { type Bar, type Rect, useStore } from "@/store";
import { box, holes } from "./Panels";

const MIN_THUMB = 24; // px

export function Scrollbars() {
  const nvim = useNvim();
  const scroll = useStore((s) => s.scroll);
  const cell = useStore((s) => s.cell);
  // One scroll_to per frame while dragging; the latest wins.
  const scrollTo = useMemo(() => {
    let pending: { win: number; top: number } | null = null;
    return (win: number, top: number) => {
      if (!pending)
        requestAnimationFrame(() => {
          nvim.notify("nvim_exec_lua", "require('corkboard').scroll_to(...)", [pending!.win, pending!.top]);
          pending = null;
        });
      pending = { win, top };
    };
  }, [nvim]);
  if (!scroll) return null;
  return scroll.bars.map((bar) => (
    <Scrollbar key={bar.win} bar={bar} floats={scroll.floats} cellW={cell.w} cellH={cell.h} scrollTo={scrollTo} />
  ));
}

function Scrollbar({
  bar,
  floats,
  cellW,
  cellH,
  scrollTo,
}: {
  bar: Bar;
  floats: Rect[];
  cellW: number;
  cellH: number;
  scrollTo: (win: number, top: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Nothing to scroll: the whole buffer is on screen.
  if (bar.top <= 1 && bar.bottom >= bar.lines) return null;

  const edge = { row: bar.row, col: bar.col + bar.width - 1, width: 1, height: bar.height };
  const trackH = bar.height * cellH;
  const shown = Math.max(1, bar.bottom - bar.top + 1);
  const thumbH = Math.min(trackH, Math.max(MIN_THUMB, (shown / bar.lines) * trackH));
  const thumbTop = ((bar.top - 1) / Math.max(1, bar.lines - shown)) * (trackH - thumbH);

  // A click on the track centres the thumb there, then drags from it, as on
  // a press of the thumb itself.
  const press = (e: React.MouseEvent) => {
    // Focus stays with the canvas, and so with Neovim.
    e.preventDefault();
    if (e.button !== 0) return;
    const scrollable = Math.max(1, bar.lines - shown);
    const rect = track.current!.getBoundingClientRect();
    const h = thumb.current!.offsetHeight;
    const travel = Math.max(1, rect.height - h);
    let startTop = bar.top;
    if (e.target !== thumb.current) {
      const y = e.clientY - rect.top - h / 2;
      startTop = 1 + Math.round((Math.max(0, Math.min(travel, y)) / travel) * scrollable);
      scrollTo(bar.win, startTop);
    }
    const startY = e.clientY;
    setDragging(true);
    const move = (m: MouseEvent) => scrollTo(bar.win, startTop + Math.round(((m.clientY - startY) / travel) * scrollable));
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Only the thumb shows until the pointer is over the track.
  return (
    <div
      className="pointer-events-none absolute z-2"
      style={{ ...box(edge, cellW, cellH), clipPath: holes(edge, floats, cellW, cellH) || undefined }}
    >
      <div
        ref={track}
        onMouseDown={press}
        onWheel={(e) => document.querySelector("#editor canvas")?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent))}
        className={cn(
          "group pointer-events-auto absolute inset-y-0 right-0 w-2.5 rounded-[5px] transition-colors hover:bg-foreground/6",
          dragging && "bg-foreground/6",
        )}
      >
        <div
          ref={thumb}
          className={cn(
            "absolute inset-x-0.5 rounded-[3px] bg-foreground/22 transition-colors group-hover:bg-foreground/35",
            dragging && "bg-foreground/45 group-hover:bg-foreground/45",
          )}
          style={{ top: Math.max(0, Math.min(trackH - thumbH, thumbTop)), height: thumbH }}
        />
      </div>
    </div>
  );
}
