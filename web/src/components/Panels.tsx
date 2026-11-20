// HTML panels laid over the Neovim windows that host them.
//
// Neovim sends corkboard.layout with every window in the current tabpage
// that shows a view buffer, in grid cells. Each gets a panel positioned
// over that rectangle; the text Neovim draws underneath stays hidden.
// Floating windows come too, and each panel is clipped around them so a
// float opened over a panel (a card, a picker) shows through from the grid.
// Keyboard focus never leaves the canvas, so every key still goes to Neovim
// (a PDF's viewer can take it with a click; it comes back as the pointer
// leaves).
//
// The board's state is one per view; a file viewer's (corkboard.viewer) is
// per buffer, since two windows can show two different images.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/Spinner";
import { keepFocus, useNvim } from "@/nvim/context";
import { box, holes } from "@/lib/clip";
import { type Layout, useStore } from "@/store";
import { VIEWS } from "@/views";
import { own } from "../../../lib/dict";

export function Panels() {
  const nvim = useNvim();
  const layout = useStore((s) => s.layout);
  const views = useStore((s) => s.views);
  const bufs = useStore((s) => s.bufs);
  const { w: cellW, h: cellH } = useStore((s) => s.cell);
  const focused = useEditorFocus();
  if (!layout) return null;
  return (
    <>
      {layout.views.map((w) => {
        const View = own(VIEWS, w.view);
        const state = bufs[w.buf] ?? own(views, w.view);
        return (
          <div
            // Another kind of view in the window (an image, then a PDF) is a
            // new panel.
            key={`${w.win}:${w.view}`}
            data-win={w.win}
            // A click in a panel is a click in its window, as on the grid:
            // the window is focused, and a float that closes on losing
            // focus (a card over the board) goes.
            onMouseDown={(e) => {
              keepFocus(e);
              if (!w.focused) nvim.lua("local w = ... if vim.api.nvim_win_is_valid(w) then vim.api.nvim_set_current_win(w) end", w.win);
            }}
            className="absolute overflow-hidden bg-background select-none"
            style={{
              ...box(w, cellW, cellH),
              // A view in a float sits above the views in windows.
              zIndex: w.float ? 3 : 1,
              clipPath: w.float ? undefined : holes(w, layout.floats, cellW, cellH) || undefined,
            }}
          >
            {w.border ? (
              // A bordered float: its border a line through the middle of
              // the border cells, as a box-drawing one would be, with the
              // title on it, and the view in the cells inside.
              <div className="float-view absolute inset-0">
                <div
                  className={cn("absolute border", w.focused ? "border-focus" : "border-border")}
                  style={{ inset: `${cellH / 2}px ${cellW / 2}px` }}
                />
                {w.title && (
                  <div className="absolute inset-x-0 top-0 flex justify-center">
                    <span className="bg-background px-ch text-muted-foreground">{w.title}</span>
                  </div>
                )}
                <div className="absolute" style={{ inset: `${cellH}px ${cellW}px` }}>
                  {View && state ? <View state={state} win={w.win} buf={w.buf} focused={!!w.focused} nvim={nvim} /> : <Spinner className="h-full" />}
                </div>
              </div>
            ) : (
              View && state ? <View state={state} win={w.win} buf={w.buf} focused={!!w.focused} nvim={nvim} /> : <Spinner className="h-full" />
            )}
          </div>
        );
      })}
      {/* A popup's ×, on its top border by the corner, over a view's
          border or the one Neovim draws. */}
      {layout.popups?.map((p) => (
        <button
          key={`close:${p.win}`}
          type="button"
          aria-label="Close"
          onMouseDown={keepFocus}
          onClick={() => void nvim.lua("require('corkboard').close_popup(...)", p.win)}
          className="absolute z-4 cursor-pointer bg-background text-center text-muted-foreground hover:text-foreground"
          style={{ left: (p.col + p.width - 4) * cellW, top: p.row * cellH, width: 3 * cellW, height: cellH }}
        >
          ×
        </button>
      ))}
      {/* A terminal put back that has yet to draw (a Claude Code session
          starting). Clicks pass through to it. */}
      {layout.wins
        ?.filter((w) => w.loading)
        .map((w) => (
          <Spinner
            key={`loading:${w.row}:${w.col}`}
            className="pointer-events-none absolute z-1 bg-background"
            style={{ ...box(w, cellW, cellH), clipPath: holes(w, layout.floats, cellW, cellH) || undefined }}
          />
        ))}
      {/* A 1px outline around the focused window and its status line. Like
          the sidebar's around the current tab, only while the keys go to
          Neovim. Above the panels; clicks pass through. */}
      {layout.focus && focused && (
        <div className="pointer-events-none absolute z-2 border border-focus" style={outline(layout.focus, cellW, cellH)} />
      )}
    </>
  );
}

// Whether focus is in the editor: its canvas, or a viewer's frame over it.
const EVENTS = ["focusin", "focusout", "focus", "blur"];
function useEditorFocus() {
  const has = () => document.hasFocus() && !!document.activeElement?.closest("#editor");
  const [focused, setFocused] = useState(has);
  useEffect(() => {
    // On the next tick, once activeElement has moved.
    const update = () => setTimeout(() => setFocused(has()));
    for (const e of EVENTS) addEventListener(e, update);
    return () => {
      for (const e of EVENTS) removeEventListener(e, update);
    };
  }, []);
  return focused;
}

// The focused window's outline. On a side with a window separator it runs
// over the separator's line, the pixel grid.js draws it on, rather than
// along the window's edge half a cell short of it.
function outline(focus: NonNullable<Layout["focus"]>, cellW: number, cellH: number) {
  const r = box(focus, cellW, cellH);
  const half = Math.floor(cellW / 2);
  const left = focus.left ? r.left - cellW + half : r.left;
  const right = focus.right ? r.left + r.width + half + 1 : r.left + r.width;
  return { ...r, left, width: right - left };
}
