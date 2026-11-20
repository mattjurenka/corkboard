// A bridge that went away (restarted, or the machine slept) is waited for,
// and the page loads again once it answers, with a new Neovim as a reload
// would. A close the bridge chose (Neovim exited, a wrong token, the plan
// opened elsewhere) stays closed.

// What the page says of a close, and whether it waits for the bridge.
export function closed(e: { code: number; reason: string }): { status: string; lost: boolean } {
  const lost = e.code === 1006 || e.code === 1001;
  return { status: e.reason || (lost ? "can't reach the bridge — reconnecting" : "nvim exited"), lost };
}

const probe = async () => (await fetch("manifest.webmanifest", { method: "HEAD", cache: "no-store" })).ok;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Asks after half a second, then twice as long each time up to 5s, until
// the bridge answers.
export async function reconnect(o: { probe?: () => Promise<boolean>; reload?: () => void; sleep?: (ms: number) => Promise<unknown> } = {}) {
  for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
    await (o.sleep ?? sleep)(wait);
    try {
      if (await (o.probe ?? probe)()) return (o.reload ?? (() => location.reload()))();
    } catch {}
  }
}
