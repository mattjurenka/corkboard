// The phone's side of nix/tests/browser.nix, run on the host: fleetd's
// browsers() (fleet/fleetd/browser.ts) against the guest's real Chromium,
// through its forwarded DevTools port, as the hub would ask it.
//   bun browser-takeover.ts <guest address>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const guest = process.argv[2];
const dir = "/tmp/takeover";
mkdirSync(join(dir, "fleet/spawns"), { recursive: true });
process.env.CORKBOARD_FLEET_STATE = join(dir, "fleet");
process.env.CORKBOARD_FLEET_MANIFEST = join(dir, "fleet.json");
writeFileSync(
  process.env.CORKBOARD_FLEET_MANIFEST,
  JSON.stringify({
    flake: "",
    owner: "test",
    memoryBudget: null,
    slots: { "agent-0": { guestAddress: guest, stateDir: dir, shareDir: dir, outboxDir: dir, unit: "agent-0.service" } },
    residents: {},
    templates: { browser: { memory: 1, cores: 1, needsApproval: false, capNames: ["claude-code", "coding", "browser"] } },
    defaultAccount: "personal",
  }),
);
const fleet = await import("../../fleet/fleetd/fleet");
const { browsers } = await import("../../fleet/fleetd/browser");
fleet.write({ id: "s1", template: "browser", task: "Log in", by: "user", account: "personal", state: "running", slot: "agent-0", created: "2026-11-22T00:00:00Z", interactive: true });

const out: any[] = [];
const ended = new Map<string, string>();
const b = browsers({ out: (_, d) => out.push(JSON.parse(d)), end: (s, why) => ended.set(s, why) });

const until = async (what: string, ok: () => unknown, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (ok()) return ok();
  throw new Error(`no ${what}: ${JSON.stringify(out.map((m) => (m.frame ? { ...m, frame: m.frame.length } : m)).slice(-5))} ${[...ended]}`);
};
const ok = async (input: object) => {
  const r = await b.input("s1", input as Record<string, unknown>);
  if (!("ok" in r)) throw new Error(`${JSON.stringify(input)}: ${r.error}`);
};
const jpeg = (m: any) => Buffer.from(m.frame, "base64").subarray(0, 2).toString("hex") === "ffd8";
const title = () => out.findLast((m) => m.tabs)?.tabs.find((t: any) => t.id === out.findLast((m) => m.tabs).tab)?.title;

// The agent's page, as it opened it, at its own size.
await b.open("phone", "s1");
await until("sign-in tab", () => title() === "Sign in");
const first = await until("frame", () => out.find((m) => m.frame));
if (!jpeg(first) || first.width !== 1280) throw new Error(`the agent's frame: ${first.width}x${first.height}`);

// Laid out for the phone.
await ok({ t: "size", width: 390, height: 700 });
await until("phone-sized frame", () => out.some((m) => m.frame && m.width === 390 && m.height === 700 && jpeg(m)));

// The login typed on the phone: the field is the page's top half.
await ok({ t: "tap", x: 0.5, y: 0.25 });
await ok({ t: "text", text: "me@example.com" });
await ok({ t: "key", key: "Enter" });
await until("signed-in title", () => title() === "in:me@example.com");

// Put back as the agent had it when the phone goes.
b.close("phone");
await Bun.sleep(1_000);
out.length = 0;
await b.open("again", "s1");
const back = await until("frame after", () => out.find((m) => m.frame));
if (back.width !== 1280) throw new Error(`not put back: ${back.width}x${back.height}`);
b.close("again");
if (ended.size) throw new Error(`ended: ${[...ended]}`);
console.log("taken over and put back");
process.exit(0);
