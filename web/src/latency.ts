// Key to pixels: how long after a key goes down the window shows something
// it did. One measurement per key, from the moment the OS delivered the key
// (the event's timeStamp) to the end of the first frame after the first
// visible change that follows it:
//
//   input   key delivered -> this page's main thread got to it. Long when
//           the renderer is busy or the machine is stalling.
//   change  key delivered -> the first change: a DOM mutation, or a Neovim
//           flush (which the grid draws in the same task, nvim/grid.js).
//           Most keys go to Neovim, so this is mostly the round trip
//           through the bridge or the wasm worker.
//   paint   key delivered -> the frame with that change in it is done
//           (requestAnimationFrame, then the task after it).
//
// A key that changes nothing within NOTHING_MS keeps change and paint null.
// `busy` marks a key that arrived while something was already changing the
// screen (a terminal streaming output, a toast): its first change may not
// be its own, so leave those out of a number that has to be the key's.
// Spinners mark themselves data-ambient and count for neither.
//
// Each window sends its samples to the bridge, which appends them to
// $XDG_STATE_HOME/corkboard/latency.jsonl (bridge/server.ts) with wall-clock
// times, so they line up with a machine-wide recorder; `bun run latency`
// summarises that file. window.__latency has the last ones, for the console.

type Sample = {
  t: number; // wall clock, ms
  key: string;
  repeat: boolean;
  busy: boolean;
  input: number;
  change: number | null;
  paint: number | null;
  via: "dom" | "nvim" | null;
  // The browser's own reading (Event Timing), when the key's handlers and
  // their frame took 16ms or more: from delivery to that frame's paint.
  event?: number;
};

const NOTHING_MS = 1000;
const BUSY_MS = 100;
const KEEP = 500;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

let pending: (Sample & { t0: number; timer: ReturnType<typeof setTimeout> }) | null = null;
let lastChange = -Infinity;
const recent: Sample[] = [];
let outbox: Sample[] = [];

function keyName(e: KeyboardEvent) {
  return [e.ctrlKey && "C", e.altKey && "A", e.metaKey && "M", e.shiftKey && e.key.length > 1 && "S"]
    .filter(Boolean)
    .concat(e.key === " " ? "Space" : e.key)
    .join("-");
}

function finish() {
  if (!pending) return;
  const { t0, timer, ...sample } = pending;
  clearTimeout(timer);
  pending = null;
  recent.push(sample);
  if (recent.length > KEEP) recent.shift();
  outbox.push(sample);
}

// After the frame that will hold what just changed: the rAF callback runs
// before it is drawn, a message posted from there runs after.
function afterFrame(fn: () => void) {
  requestAnimationFrame(() => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = fn;
    port2.postMessage(null);
  });
}

function changed(via: "dom" | "nvim") {
  const now = performance.now();
  lastChange = now;
  const p = pending;
  if (!p || p.change !== null) return;
  p.change = now - p.t0;
  p.via = via;
  afterFrame(() => {
    if (pending !== p) return;
    p.paint = performance.now() - p.t0;
    finish();
  });
}

/** A Neovim flush: the grid has just drawn it. */
export const nvimFlushed = () => changed("nvim");

export function startLatency(send: (samples: Sample[]) => void) {
  addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (MODIFIERS.has(e.key)) return;
      // A key before the last one's change ends that one as a no-change.
      finish();
      const now = performance.now();
      pending = {
        t0: e.timeStamp,
        t: Math.round(performance.timeOrigin + e.timeStamp),
        key: keyName(e),
        repeat: e.repeat,
        busy: now - lastChange < BUSY_MS,
        input: now - e.timeStamp,
        change: null,
        paint: null,
        via: null,
        timer: setTimeout(finish, NOTHING_MS),
      };
    },
    true,
  );

  // Spinners tick on their own (data-ambient); a key didn't move them.
  const ambient = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest("[data-ambient]");
  new MutationObserver((records) => {
    if (records.some((r) => !ambient(r.target))) changed("dom");
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  // The browser's own key-to-paint, for the keys slow enough to report.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name !== "keydown") continue;
        const t = Math.round(performance.timeOrigin + entry.startTime);
        const s = recent.findLast((r) => r.t === t) ?? (pending?.t === t ? pending : undefined);
        if (s) s.event = entry.duration;
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  } catch {}

  const flush = () => {
    if (!outbox.length) return;
    send(outbox);
    outbox = [];
  };
  setInterval(flush, 5000);
  addEventListener("pagehide", flush);

  (window as any).__latency = {
    recent,
    summary() {
      const rows: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
      const by = new Map<string, Sample[]>();
      for (const s of recent) if (s.paint !== null && !s.busy) by.set(s.key, [...(by.get(s.key) ?? []), s]);
      for (const [key, xs] of by) {
        const v = xs.map((s) => s.paint!).sort((a, b) => a - b);
        const at = (q: number) => Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))]);
        rows[key] = { n: v.length, p50: at(0.5), p95: at(0.95), max: Math.round(v.at(-1)!) };
      }
      console.table(rows);
    },
  };
}
