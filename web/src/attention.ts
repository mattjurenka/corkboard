// Desktop notifications for cards whose agent is asking something of the
// user (a card's attention field; see corkboard/board.lua and mcp/board.ts).
// Each new request notifies once; clicking it brings this window up with the
// card open. Notifications need a secure context, which loopback is.

type Card = { id: string; title: string; agent?: string; attention?: string };

let seen = new Map<string, string>();
let primed = false;

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

// Called with every board state. The first one only records what is already
// asked for: those show on the board, and a reload shouldn't repeat them.
export function notifyAttention(cards: Card[], open: (id: string) => void) {
  const next = new Map<string, string>();
  for (const c of cards) {
    if (!c.attention) continue;
    next.set(c.id, c.attention);
    if (!primed || seen.get(c.id) === c.attention) continue;
    if (!("Notification" in window) || Notification.permission !== "granted") continue;
    const n = new Notification(`${c.agent ?? "An agent"} needs you`, {
      body: `${c.title}\n${c.attention}`,
      tag: `corkboard:${c.id}`,
      icon: "/icon-192.png",
    });
    n.onclick = () => {
      window.focus();
      open(c.id);
      n.close();
    };
  }
  seen = next;
  primed = true;
}
