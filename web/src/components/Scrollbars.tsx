// A scrollbar on the right edge of each window of text, from
// corkboard.scroll. Neovim owns the scrolling: the thumb is drawn from where
// the window is, and dragging it or clicking the track asks Neovim to move
// there (corkboard.scroll_to), which then sends the new position back. The
// wheel passes through to the canvas, which scrolls as it always has.
//
// Each bar covers the window's last column and is clipped around floats
// like a panel, so a picker over it is not drawn through. A window wide
// enough, once its buffer's text has come (corkboard.minimap), has a
// minimap instead: its last columns, the buffer a character a pixel, with
// the lines on screen shaded, scrolling with the window when the buffer is
// taller than it. Either is marked down its right edge where the file has
// changed since the last commit, in the files panel's colours, and across
// at the cursor's line.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNvim } from "@/nvim/context";
import { type Bar, type GitRange, type Minimap as Map, type Rect, useStore } from "@/store";
import { box, holes } from "./Panels";

const MIN_THUMB = 24; // px
// The minimap's width in cells, in a window of at least MAP_MIN of them.
const MAP_COLS = 12;
const MAP_MIN = 60;
// px a line, and a character.
const LINE_H = 2;
const CHAR_W = 1;

const GIT_COLOR: Record<GitRange[2], string> = { add: "bg-working", change: "bg-review", delete: "bg-blocked" };

// The changes down the right edge: y gives a line's top in px, h the height
// of n lines.
function GitMarks({ git, y, h }: { git?: GitRange[]; y: (line: number) => number; h: (n: number) => number }) {
  return git?.map(([first, n, kind]) => (
    <div
      key={`${first}:${kind}`}
      className={cn("pointer-events-none absolute right-0 w-[3px]", GIT_COLOR[kind])}
      style={{ top: y(first), height: Math.max(2, h(n)) }}
    />
  ));
}

export function Scrollbars() {
  const nvim = useNvim();
  const scroll = useStore((s) => s.scroll);
  const minimaps = useStore((s) => s.minimaps);
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
  return scroll.bars.map((bar) =>
    minimaps[bar.buf] && bar.width >= MAP_MIN ? (
      <Minimap
        key={bar.win}
        bar={bar}
        map={minimaps[bar.buf]}
        floats={scroll.floats}
        cellW={cell.w}
        cellH={cell.h}
        scrollTo={scrollTo}
      />
    ) : (
      <Scrollbar key={bar.win} bar={bar} floats={scroll.floats} cellW={cell.w} cellH={cell.h} scrollTo={scrollTo} />
    ),
  );
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
        onWheel={passWheel}
        className={cn(
          "group pointer-events-auto absolute inset-y-0 right-0 w-2.5 rounded-[5px] transition-colors hover:bg-foreground/6",
          dragging && "bg-foreground/6",
        )}
      >
        <GitMarks git={bar.git} y={(l) => ((l - 1) / bar.lines) * trackH} h={(n) => (n / bar.lines) * trackH} />
        <div
          className="pointer-events-none absolute inset-x-0 z-1 h-0.5 bg-foreground/70"
          style={{ top: Math.min(trackH - 2, ((bar.cursor - 1) / bar.lines) * trackH) }}
        />
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

const passWheel = (e: React.WheelEvent) =>
  document.querySelector("#editor canvas")?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent));

function Minimap({
  bar,
  map,
  floats,
  cellW,
  cellH,
  scrollTo,
}: {
  bar: Bar;
  map: Map;
  floats: Rect[];
  cellW: number;
  cellH: number;
  scrollTo: (win: number, top: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);
  const edge = { row: bar.row, col: bar.col + bar.width - MAP_COLS, width: MAP_COLS, height: bar.height };
  const w = MAP_COLS * cellW;
  const h = bar.height * cellH;
  const shown = Math.max(1, bar.bottom - bar.top + 1);
  const scrollable = Math.max(0, bar.lines - shown);
  const content = bar.lines * LINE_H;
  // Taller than the window, the map moves as far through itself as the
  // window has through the buffer.
  const offset = content > h && scrollable ? ((bar.top - 1) / scrollable) * (content - h) : 0;
  const sliderTop = (bar.top - 1) * LINE_H - offset;
  const sliderH = shown * LINE_H;
  // How far the slider moves from the first line on screen to the last.
  const travel = content > h ? h - sliderH : scrollable * LINE_H;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.7;
    const fg = getComputedStyle(c).color;
    const first = Math.floor(offset / LINE_H);
    const last = Math.min(map.lines.length, first + Math.ceil(h / LINE_H) + 1);
    for (let i = first; i < last; i++) {
      const runs = map.lines[i];
      const y = i * LINE_H - offset;
      for (let r = 0; r < runs.length; r += 3) {
        ctx.fillStyle = map.palette[runs[r + 2]] || fg;
        ctx.fillRect(runs[r] * CHAR_W, y, runs[r + 1] * CHAR_W, LINE_H);
      }
    }
  }, [map, w, h, offset]);

  // A press on the slider drags it; anywhere else first centres the lines
  // on screen there.
  const press = (e: React.MouseEvent) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const rect = canvas.current!.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let startTop = bar.top;
    if (y < sliderTop || y > sliderTop + sliderH) {
      startTop = Math.max(1, Math.floor((y + offset) / LINE_H) + 1 - Math.floor(shown / 2));
      scrollTo(bar.win, startTop);
    }
    const startY = e.clientY;
    setDragging(true);
    const move = (m: MouseEvent) =>
      scrollTo(bar.win, startTop + Math.round(((m.clientY - startY) / Math.max(1, travel)) * scrollable));
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="group absolute z-2 bg-background text-foreground"
      style={{ ...box(edge, cellW, cellH), clipPath: holes(edge, floats, cellW, cellH) || undefined }}
      onMouseDown={press}
      onWheel={passWheel}
    >
      <canvas ref={canvas} className="absolute inset-0" style={{ width: w, height: h }} />
      <GitMarks git={bar.git} y={(l) => (l - 1) * LINE_H - offset} h={(n) => n * LINE_H} />
      <div
        className="pointer-events-none absolute inset-x-0 bg-foreground/60"
        style={{ top: (bar.cursor - 1) * LINE_H - offset, height: LINE_H }}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bg-foreground/8 transition-colors group-hover:bg-foreground/14",
          dragging && "bg-foreground/20 group-hover:bg-foreground/20",
        )}
        style={{ top: sliderTop, height: Math.max(cellH / 2, sliderH) }}
      />
    </div>
  );
}
