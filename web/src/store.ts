// What Neovim has told the page, in one place the components read from.
// main.tsx writes to it from the RPC handlers; set() takes a partial state
// and a component re-renders when the slice it selected changes.

import { useSyncExternalStore } from "react";
import type { Note } from "./attention";

export type Ext = { __ext: number; id: number };

// A window that shows a view buffer, or a float, in grid cells
// (corkboard.layout).
export type Rect = { row: number; col: number; width: number; height: number };
export type ViewWin = Rect & { win: number; buf: number; view: string; focused?: boolean; float?: boolean };
export type Layout = { views: ViewWin[]; floats: Rect[]; focus: Rect | null };

// One window of text's scroll position (corkboard.scroll).
export type Bar = Rect & { win: number; top: number; bottom: number; lines: number };
export type Scroll = { bars: Bar[]; floats: Rect[] };

export type Tab = { tab: Ext; name: string };

export type State = {
  host: string | null;
  // "plan" in the day plan's window (?view=plan), which has no sidebar.
  view: string | null;
  // The tab the file explorer previews into (corkboard.push_preview), shown
  // in italics while its file is untouched.
  previewTab: number | null;
  context: { cwd: string; file?: string } | null;
  tabs: { current: Ext; tabs: Tab[] } | null;
  layout: Layout | null;
  scroll: Scroll | null;
  // The latest state of each view (board, usage) and of each viewer buffer.
  views: Record<string, any>;
  bufs: Record<number, any>;
  // Bumped when the cell size changes, so positions are worked out again.
  cell: { w: number; h: number };
  // Bumped when files in the project come or go.
  filesVersion: number;
  status: string | null;
  // This page's notifications, newest first, and how many came since the
  // list was last opened.
  notifications: Note[];
  unread: number;
};

let state: State = {
  host: null,
  view: null,
  previewTab: null,
  context: null,
  tabs: null,
  layout: null,
  scroll: null,
  views: {},
  bufs: {},
  cell: { w: 9, h: 19 },
  filesVersion: 0,
  status: null,
  notifications: [],
  unread: 0,
};

const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<State>) {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state));
}
