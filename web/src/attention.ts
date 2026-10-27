// Desktop notifications, and the list of them the sidebar keeps for this
// page (Notifications in Sidebar.tsx). Two sources: cards whose agent is
// asking something of the user (a card's attention field; see
// corkboard/board.lua and mcp/board.ts), and Claude Code sessions' own
// PushNotification calls (corkboard.notification, from
// nvim/hooks/claude-notification.lua). Every one is listed, including those
// that raised nothing. Clicking one brings this window up (with the card
// open, for a card). Notifications need a secure context, which loopback is.

import { store } from "./store";

type Card = { id: string; title: string; agent?: string; attention?: string };

export type Note = {
  id: number;
  time: number;
  title: string;
  body: string;
  // Whether it raised a desktop notification, and if not, why not.
  shown: boolean;
  reason?: string;
  open?: () => void;
};

let nextId = 1;

function record(note: Omit<Note, "id" | "time" | "shown">, want: boolean) {
  const permitted = "Notification" in window && Notification.permission === "granted";
  const shown = want && permitted;
  const entry: Note = { ...note, id: nextId++, time: Date.now(), shown };
  if (want && !permitted) entry.reason = "this page may not send notifications";
  const { notifications, unread } = store.get();
  store.set({ notifications: [entry, ...notifications], unread: unread + 1 });
  if (!shown) return;
  const n = new Notification(entry.title, { body: entry.body, tag: `corkboard:${entry.id}`, icon: "/icon-192.png" });
  n.onclick = () => {
    window.focus();
    entry.open?.();
    n.close();
  };
}

// Browsers grant permission only from a user gesture, so ask on the first one.
export function askPermissionOnGesture() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  const ask = () => {
    removeEventListener("pointerdown", ask, true);
    removeEventListener("keydown", ask, true);
    Notification.requestPermission();
  };
  addEventListener("pointerdown", ask, true);
  addEventListener("keydown", ask, true);
}

let seen = new Map<string, string>();
let primed = false;

// Called with every board state; each new request notifies once. The first
// state only records what is already asked for: those show on the board,
// and a reload shouldn't repeat them.
export function notifyAttention(cards: Card[], open: (id: string) => void) {
  const next = new Map<string, string>();
  for (const c of cards) {
    if (!c.attention) continue;
    next.set(c.id, c.attention);
    if (!primed || seen.get(c.id) === c.attention) continue;
    record({ title: `${c.agent ?? "An agent"} needs you`, body: `${c.title}\n${c.attention}`, open: () => open(c.id) }, true);
  }
  seen = next;
  primed = true;
}

// A Claude Code session's PushNotification. Claude Code decides whether to
// send it, but from inside a terminal in this page its guess at whether you
// are looking can be wrong, so one it held back still shows if this window
// isn't focused.
// Clicking it goes to the session's terminal, when the hook knew which.
export function notifyClaude(n: { message: string; cwd?: string; sent: boolean; reason?: string; buf?: number }, open: (buf: number) => void) {
  const project = n.cwd?.split("/").at(-1);
  const want = n.sent || !document.hasFocus();
  record(
    {
      title: project ? `Claude Code · ${project}` : "Claude Code",
      body: n.message,
      reason: want ? undefined : (n.reason ?? "held back by Claude Code"),
      open: n.buf ? () => open(n.buf!) : undefined,
    },
    want,
  );
}

// Away mode took you to a session in this window, but you picked it in
// another, and a page can't bring its own window up: clicking this does.
export function notifyBack() {
  record({ title: "corkboard", body: "The session you picked from away mode is in this window." }, true);
}

export function clearNotifications() {
  store.set({ notifications: [], unread: 0 });
}
