// What Neovim has told the page, in one place the components read from.
// main.tsx writes to it from the RPC handlers; set() takes a partial state
// and a component re-renders when the slice it selected changes.

import { useSyncExternalStore } from "react";
import type { Note } from "./attention";
import { type Skeleton, load as loadSkeleton } from "./skeleton";

// Where the page goes to one column (narrow, below).
export const NARROW = "(max-width: 800px)";

export type Ext = { __ext: number; id: number };

// A toast in the editor's corner (corkboard.toast): pending until Neovim
// says how it ended.
// A brain as the form edits it (corkboard.brains fields()).
export type BrainFields = {
  name: string;
  title: string;
  description: string;
  account: string | null;
  credentials: string[];
  abilities: string[];
  persona: string | null;
  skin: string | null;
  default: boolean;
  updated?: string;
};
// What a, or e on one, opens: the brain, none for a new one, the live
// brains to pick accounts and labels from or start from, the abilities, and
// the avatar's personas.
export type BrainFormData = { brain?: BrainFields; brains: BrainFields[]; abilities: string[]; personas: string[] };

// A hold as its form edits it (corkboard.holds fields()): secret, how long
// ago it was set here; recorded false for a name with no record yet;
// templates, those holding it in Nix, which fix its name.
export type HoldFields = {
  name: string;
  about: string;
  where: string | null;
  secret: string | null;
  recorded: boolean;
  updated: string | null;
  templates: string[];
};

export type Toast = { id: string; kind: "pending" | "done" | "error"; text: string };

// A window that shows a view buffer, or a float, in grid cells
// (corkboard.layout).
export type Rect = { row: number; col: number; width: number; height: number };
export type ViewWin = Rect & { win: number; buf: number; view: string; focused?: boolean;
  float?: boolean;
  border?: boolean;
  title?: string;
};
// focus's left/right: a window separator on that side (see Panels). wins:
// every split, loading while its terminal has yet to draw; restored: whether
// Neovim has put the editor back as it was (corkboard.restore).
export type Layout = {
  views: ViewWin[];
  floats: Rect[];
  popups?: (Rect & { win: number })[];
  focus: (Rect & { left?: boolean; right?: boolean }) | null;
  wins?: (Rect & { loading?: boolean })[];
  restored?: boolean;
};

// One window of text's scroll position (corkboard.scroll).
// git: the lines changed since the last commit, as [first line, count, kind].
export type GitRange = [number, number, "add" | "change" | "delete"];
export type Bar = Rect & { win: number; buf: number; top: number; bottom: number; lines: number; cursor: number; git?: GitRange[] };
// A buffer's text for the minimap (corkboard.minimap): each line's runs of
// characters as [column, width, colour] triples, colour indexing palette.
export type Minimap = { palette: string[]; lines: number[][] };
export type Scroll = { bars: Bar[]; floats: Rect[] };

// label: what Neovim calls it where the buffer name reads badly
// (corkboard.tab_labels), with a Claude Code session's state from its hooks.
export type Tab = { tab: Ext; name: string; label?: { title: string; kind: string; state?: string } };

// Away mode, from the bridge (bridge/away.ts): every page's Claude Code
// sessions, each on page (the bridge's id for it) in terminal buf. at: when
// it came to its state, on the bridge's clock, whose time now is. ready is
// finished while you were away; idle, before.
// A page's by its id and buffer; another bridge's by the bridge and its key.
export type AwaySession = {
  page?: number;
  buf?: number;
  bridge?: string;
  key?: string;
  project: string;
  name: string;
  detail?: string;
  at: number;
  // When you last said something to it.
  typed?: number;
  state: "working" | "needs" | "ready" | "idle";
};
export type Away = { since: number; now: number; wake: string | null; sessions: AwaySession[] };

export type State = {
  host: string | null;
  // "plan" in the day plan's window (?view=plan), which has no sidebar.
  view: string | null;
  // The tab the file explorer previews into (corkboard.push_preview), shown
  // in italics while its file is untouched.
  previewTab: number | null;
  // none: no project open yet (util.no_project), so what needs one is greyed out.
  context: { cwd: string; project?: string; file?: string; none?: boolean } | null;
  tabs: { current: Ext; tabs: Tab[] } | null;
  layout: Layout | null;
  scroll: Scroll | null;
  minimaps: Record<number, Minimap>;
  // The latest state of each view (board, usage) and of each viewer buffer.
  views: Record<string, any>;
  bufs: Record<number, any>;
  // Bumped when the cell size changes, so positions are worked out again.
  cell: { w: number; h: number };
  // Bumped when files in the project come or go.
  filesVersion: number;
  // The last file opened in a window, counted so opening it again counts.
  opened: { file: string; n: number } | null;
  // Whether the sidebar shows the files (the View menu, or their header),
  // kept for the next time the page opens.
  filesOpen: boolean;
  // corkboard's shortcuts and their keys, by name (settings.lua's
  // Keybindings), for the menu bar.
  keys: Record<string, string[]>;
  status: string | null;
  // This page's notifications, newest first, and how many came since the
  // list was last opened.
  notifications: Note[];
  unread: number;
  // The tabs and windows as the page last saw them (skeleton.ts), shown
  // loading until Neovim has put the editor back.
  skeleton: Skeleton | null;
  // The tab asked for from the sidebar, until its layout comes: its windows
  // (skeleton.ts) show loading over the editor meanwhile.
  switching: number | null;
  // Focus mode (corkboard/focus.lua): no sidebar, and the grid this many
  // columns wide in the middle of the page. Null when off.
  focus: { width: number } | null;
  // A narrow page (a phone, a skinny window; NARROW): one column, the
  // sidebar a drawer over the editor, open while drawer is set.
  narrow: boolean;
  drawer: boolean;
  // Keys go by the on-screen keyboard (#keys in App.tsx), not the canvas.
  keyboard: boolean;
  // Away mode, while it's on.
  away: Away | null;
  // The tool picker (corkboard.picker.tools), while it's open.
  tools: { leader: string; tools: { text: string; hint: string; off?: boolean }[] } | null;
  // The brain form (corkboard.brains), while it's open.
  brainForm: BrainFormData | null;
  // The hold form (corkboard.holds), while it's open: the hold, none for a new one.
  holdForm: { hold: HoldFields | null } | null;
  // A question (corkboard.ask), while it's open: text to type
  // (vim.ui.input), or one of its choices (vim.ui.select).
  ask: { id: number; prompt: string; default: string; choices?: string[] } | null;
  // Pairing a device (corkboard.pair), while it's open.
  pair: {
    step: "code" | "waiting" | "sas" | "done" | "error";
    error?: string;
    name?: string;
    sas?: string;
    passphrase?: boolean;
    confirming?: boolean;
    refused?: boolean;
  } | null;
  // Open project (corkboard.picker), while it's open. here: this window has a
  // project, so the one chosen opens in a window of its own; naming: straight
  // to naming a new one (the Projects tab's n).
  projects: { here: boolean; naming?: boolean } | null;
  // The projects with a window on this machine (the bridge's openWindow).
  windows: string[];
  toasts: Toast[];
  // Which of corkboard's parts are on (corkboard.features): what's off isn't shown.
  features: { fleet: boolean; assistant: boolean };
  // Whether Neovim has Vim's keys or an editor's (corkboard.vim).
  vim: boolean;
  // The page's zoom, in percent (corkboard.theme).
  zoom: number;
};

let state: State = {
  host: null,
  view: null,
  previewTab: null,
  context: null,
  tabs: null,
  layout: null,
  scroll: null,
  minimaps: {},
  views: {},
  bufs: {},
  cell: { w: 9, h: 19 },
  filesVersion: 0,
  opened: null,
  filesOpen: remembered("corkboard.files") !== "closed",
  keys: {},
  status: null,
  notifications: [],
  unread: 0,
  skeleton: loadSkeleton(),
  switching: null,
  focus: null,
  narrow: matchMedia(NARROW).matches,
  drawer: false,
  keyboard: false,
  away: null,
  tools: null,
  brainForm: null,
  holdForm: null,
  ask: null,
  pair: null,
  projects: null,
  windows: [],
  toasts: [],
  features: { fleet: false, assistant: false },
  vim: false,
  zoom: 100,
};

// localStorage can be missing or refuse (a private window).
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<State>) {
    if ("filesOpen" in patch && patch.filesOpen !== state.filesOpen) {
      try {
        localStorage.setItem("corkboard.files", patch.filesOpen ? "open" : "closed");
      } catch {}
    }
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
