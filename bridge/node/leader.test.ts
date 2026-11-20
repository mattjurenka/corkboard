import { describe, expect, it } from "bun:test";
import type { NodesView } from "../../lib/e2ee/wire";
import { type ForgeProcess, Leadership, forgeKeeper } from "./leader";

const view = (connected: { device: string; since: number; tunnel?: false }[], leader: string | null = null, forge = false) =>
  ({ connected, leader, forge }) as unknown as NodesView;

// The relay's answer, as set, and how often it was asked.
function relay(v: NodesView) {
  const r = { v, asked: 0, nodes: async () => (r.asked++, r.v) };
  return r;
}

describe("which node leads", () => {
  it("is this one, with no relay or no tunnel to ask", async () => {
    const l = new Leadership({ me: "me", nodes: () => undefined });
    expect(await l.leader()).toBe("me");
    expect(await l.leads()).toBe(true);
  });

  it("is the leader the account names while it's connected, else the newest connected, and never one that takes no tunnel", async () => {
    let now = 0;
    const r = relay(view([{ device: "old", since: 1 }, { device: "named", since: 2 }, { device: "new", since: 3 }], "named", true));
    const l = new Leadership({ me: "me", nodes: () => r.nodes, now: () => now });
    expect(await l.leader()).toBe("named");
    expect(l.forgeWeb).toBe(true);
    expect(await l.leads()).toBe(false);
    // The named one gone: the newest. A fleetd that takes no tunnel isn't one.
    r.v = view([{ device: "old", since: 1 }, { device: "fleetd", since: 9, tunnel: false }, { device: "new", since: 3 }], "named");
    now += 60_000;
    expect(await l.leader()).toBe("new");
    expect(l.forgeWeb).toBe(false);
    // None connected (this one's socket down): this one.
    r.v = view([], "named");
    now += 60_000;
    expect(await l.leader()).toBe("me");
  });

  it("asks the relay at most once a minute, and takes its word when it says", async () => {
    let now = 0;
    const r = relay(view([{ device: "a", since: 1 }], "a"));
    const l = new Leadership({ me: "me", nodes: () => r.nodes, now: () => now });
    await l.leader();
    now += 59_999;
    expect(await l.leader()).toBe("a");
    expect(r.asked).toBe(1);
    now += 1;
    await l.leader();
    expect(r.asked).toBe(2);
    // The tunnel's onLeader: now, and for the next minute.
    l.told("b");
    expect(await l.leader()).toBe("b");
    l.told(null);
    expect(await l.leads()).toBe(true);
    expect(r.asked).toBe(2);
  });

  it("throws what the relay throws, keeping nothing", async () => {
    const l = new Leadership({ me: "me", nodes: () => async () => Promise.reject(new Error("offline")) });
    await expect(l.leads()).rejects.toThrow("offline");
  });
});

// A Forgejo that records what it's told.
function forgejo(running = false) {
  const said: string[] = [];
  const f: ForgeProcess & { said: string[]; admin: string[] } = {
    said,
    admin: ["matt"],
    running,
    start: async () => void (said.push("start"), (f.running = true)),
    stop: async () => void (said.push("stop"), (f.running = false)),
    admins: async () => f.admin,
  };
  return f;
}
const states = () => {
  const said: string[] = [];
  return { said, restore: async () => (said.push("restore"), 3), step: async (_now?: number, force?: boolean) => void said.push(force ? "final step" : "step") };
};

describe("keeping the forge", () => {
  it("runs it on the leader the account names, restoring it first, and records its one admin as the login", async () => {
    const f = forgejo();
    const s = states();
    let user: string | undefined;
    const keep = forgeKeeper({ forge: f, me: "me", named: async () => "me", leads: async () => false, snapshots: s, records: { user: () => user, setUser: async (u) => (user = u) } });
    await keep();
    expect(f.said).toEqual(["start"]);
    expect(s.said).toEqual(["restore", "step"]);
    expect(user).toBe("matt");
    // Running, it's stepped again, not restored.
    await keep();
    expect(s.said).toEqual(["restore", "step", "step"]);
    // Two admins: no telling whose.
    user = undefined;
    f.admin = ["a", "b"];
    await keep();
    expect(user).toBeUndefined();
  });

  it("stops it where another is named, sending its state on at once; with none named, goes by who leads", async () => {
    const f = forgejo(true);
    const s = states();
    let named: string | null = "other";
    let leads = true;
    const keep = forgeKeeper({ forge: f, me: "me", named: async () => named, leads: async () => leads, snapshots: s, records: { user: () => "u", setUser: async () => {} } });
    await keep();
    expect(f.said).toEqual(["stop"]);
    expect(s.said).toEqual(["final step"]);
    // Not running: stopped (a start under way) and nothing sent.
    await keep();
    expect(f.said).toEqual(["stop", "stop"]);
    expect(s.said).toEqual(["final step"]);
    named = null;
    await keep();
    expect(f.said.at(-1)).toBe("start");
    leads = false;
    await keep();
    expect(f.said.at(-1)).toBe("stop");
  });

  it("changes nothing when the look fails, and does nothing with no forge", async () => {
    const f = forgejo(true);
    const logged: string[] = [];
    await forgeKeeper({ forge: f, me: "me", named: () => Promise.reject(new Error("relay down")), leads: async () => true, records: { user: () => "u", setUser: async () => {} }, log: (l) => logged.push(l) })();
    expect(f.said).toEqual([]);
    expect(f.running).toBe(true);
    expect(logged).toEqual(["node: the forge: relay down"]);
    await forgeKeeper({ me: "me", named: () => Promise.reject(new Error("never asked")), leads: async () => true, records: { user: () => "u", setUser: async () => {} }, log: (l) => logged.push(l) })();
    expect(logged).toHaveLength(1);
  });
});
