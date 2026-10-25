// The tabs and the current tab's windows as the page last saw them, kept
// for the next load (a reload, usually): until Neovim has put the editor
// back, the sidebar lists those tabs and each window shows it is loading.
// One per window of the app (the query: project, host, day plan).

import type { Rect, State } from "./store";

export type Skeleton = { tabs: NonNullable<State["tabs"]>; wins: Rect[] };

const key = "corkboard.skeleton" + location.search;

export function save(state: State) {
  const { tabs, layout } = state;
  if (!tabs || !layout?.restored || !layout.wins) return;
  const wins = layout.wins.map(({ row, col, width, height }) => ({ row, col, width, height }));
  try {
    localStorage.setItem(key, JSON.stringify({ tabs, wins } satisfies Skeleton));
  } catch {}
}

export function load(): Skeleton | null {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null");
    return s?.tabs && Array.isArray(s.wins) ? s : null;
  } catch {
    return null;
  }
}
