// Away mode: every page goes dark but for the Claude Code sessions of every
// project this bridge has open, and one page chimes when it's time to come
// back. Each page's Neovim tells the bridge what its sessions are doing
// ("corkboard.sessions", from corkboard/away.lua); this keeps them together,
// with how long each has been in its state, and decides when to wake you.
//
// It wakes you once, when a session asks something, when every session has
// stopped, or when one has sat finished for WAIT_MS. Staying away (space on
// the page) counts only what happens after it. Something asked or finished
// before you left shows, but doesn't wake you.

export type Page = {
  host?: string;
  // A notification to the page, and Lua run in its Neovim.
  notify(method: string, ...params: unknown[]): void;
  exec(lua: string, ...args: unknown[]): void;
};

// What a Neovim says of one session.
type Reported = { buf: number; project: string; name: string; state: string; detail?: string };
// working and starting are busy; asking and permission need you.
type Kind = "busy" | "needs" | "idle";
type Live = Reported & { kind: Kind; since: number };

const WAIT_MS = 20 * 60 * 1000;

const kind = (state: string): Kind =>
  state === "asking" || state === "permission" ? "needs" : state === "idle" ? "idle" : "busy";

const sessions = new Map<Page, Map<number, Live>>();
const ids = new Map<Page, number>();
let nextId = 1;

// While away: when it started, what counts as new (since, or the last
// "stay away"), why it woke you if it has, and the page that chimes.
let away: { since: number; ack: number; wake: string | null; page: Page } | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

// Every page's sessions, each project named with its machine if it's
// another one.
function all() {
  return [...sessions].flatMap(([page, bufs]) =>
    [...bufs.values()].map((s) => ({ page, ...s, project: page.host ? `${page.host}:${s.project}` : s.project })),
  );
}

// The page's view of it: each session as working, needs, ready (finished
// while you were away) or idle (finished before).
function state() {
  if (!away) return null;
  const since = away.since;
  return {
    since,
    now: Date.now(),
    wake: away.wake,
    sessions: all().map(({ page, buf, project, name, kind, since: at, detail }) => ({
      page: ids.get(page),
      buf,
      project,
      name,
      detail,
      at,
      state: kind === "busy" ? "working" : kind === "needs" ? "needs" : at > since ? "ready" : "idle",
    })),
  };
}

function broadcast() {
  const s = state();
  for (const page of ids.keys()) page.notify("corkboard.away", s);
}

// Why to wake you now, if it's time.
function reason(): string | null {
  if (!away) return null;
  const list = all();
  const ack = away.ack;
  const asking = list.find((s) => s.kind === "needs" && s.since > ack);
  if (asking) return `${asking.project} needs you`;
  const fresh = list.filter((s) => s.kind === "idle" && s.since > ack);
  if (fresh.length && list.every((s) => s.kind !== "busy")) return "all stopped";
  const waited = fresh.find((s) => Date.now() - s.since >= WAIT_MS);
  if (waited) return `${waited.project} waited ${WAIT_MS / 60000}m`;
  return null;
}

function check() {
  if (!away || away.wake) return;
  const why = reason();
  if (!why) return;
  away.wake = why;
  (ids.has(away.page) ? away.page : ids.keys().next().value)?.notify("corkboard.chime");
}

function update() {
  check();
  broadcast();
}

export function opened(page: Page) {
  ids.set(page, nextId++);
  if (away) page.notify("corkboard.away", state());
}

export function closed(page: Page) {
  ids.delete(page);
  if (sessions.delete(page)) update();
}

// A Neovim's sessions, all of them each time.
export function report(page: Page, list: Reported[]) {
  const was = sessions.get(page) ?? new Map<number, Live>();
  const now = new Map<number, Live>();
  for (const r of list) {
    const k = kind(r.state);
    const before = was.get(r.buf);
    now.set(r.buf, { ...r, kind: k, since: before?.kind === k ? before.since : Date.now() });
  }
  sessions.set(page, now);
  if (away) update();
}

export function enter(page: Page) {
  if (away) return;
  const now = Date.now();
  away = { since: now, ack: now, wake: null, page };
  // For the WAIT_MS rule, which no report would set off.
  timer = setInterval(update, 30 * 1000);
  update();
}

function leave() {
  away = null;
  clearInterval(timer);
  broadcast();
}

// What a page sends: "leave"; "stay", which keeps you away and counts only
// what comes after; "go" to a session (its page's id, its buffer), which
// leaves and brings that session up in its own page.
export function command(from: Page, op: string, args: unknown[]) {
  if (op === "leave") return leave();
  if (op === "stay" && away) {
    away.ack = Date.now();
    away.wake = null;
    away.page = from;
    return update();
  }
  if (op === "go") {
    const [id, buf] = args as [number, number];
    const page = [...ids].find(([, i]) => i === id)?.[0];
    leave();
    if (!page) return;
    page.exec("require('corkboard.terminal').focus(...)", buf);
    page.notify("corkboard.away_return", from === page);
  }
}
