// h/j/k/l over a view's items as they're drawn (pinned.nav in Neovim): the
// item that way from the current one. One the current one lines up with
// (the same column going up or down, the same rows going sideways) wins
// over one off to the side, the nearest of those first; failing any, the
// nearest at all.

export type Dir = "up" | "down" | "left" | "right";
type Box = { left: number; top: number; right: number; bottom: number };

// A pixel's give, for borders shared by neighbours.
const GIVE = 1;

const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);

export function nearest<T extends { box: Box }>(from: Box, items: T[], dir: Dir): T | undefined {
  const across = dir === "up" || dir === "down";
  let best: T | undefined;
  let key: number[] = [];
  for (const it of items) {
    const b = it.box;
    const ahead = { down: b.top - from.bottom, up: from.top - b.bottom, right: b.left - from.right, left: from.left - b.right }[dir];
    if (ahead < -GIVE) continue;
    const dist = Math.max(0, ahead);
    const off = across ? gap(from.left, from.right, b.left, b.right) : gap(from.top, from.bottom, b.top, b.bottom);
    const skew = across ? Math.abs(b.left - from.left) : Math.abs(b.top - from.top);
    const k = off === 0 ? [0, dist, skew] : [1, dist + off, skew];
    if (!best || lower(k, key)) {
      best = it;
      key = k;
    }
  }
  return best;
}

const lower = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// Several presses before Neovim's cursor has caught up all name the item it
// was on; each goes on from where the last one went.
let last: { win: number; from?: string; to: string; at: number } | undefined;

export function navigate(win: number, dir: Dir, asked: string | undefined): string | undefined {
  const panel = document.querySelector(`[data-win="${win}"]`);
  if (!panel) return;
  const items = [...panel.querySelectorAll<HTMLElement>("[data-nav]")].map((el) => ({ id: el.dataset.nav!, box: el.getBoundingClientRect() }));
  const from = last && last.win === win && last.from === asked && performance.now() - last.at < 1000 ? last.to : asked;
  const here =
    items.find((it) => it.id === from) ??
    items.find((it) => it.id === panel.querySelector<HTMLElement>("[data-selected]")?.closest<HTMLElement>("[data-nav]")?.dataset.nav);
  const to = here ? nearest(here.box, items.filter((it) => it !== here), dir) : items[0];
  if (!to) return;
  last = { win, from: asked, to: to.id, at: performance.now() };
  return to.id;
}
