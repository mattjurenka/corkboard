// fleetd's scheduling: which queued spawns start, given slots, residents and
// the memory budget.   bun test fleet/fleetd
import { expect, test } from "bun:test";
import { accountFor, egressOf, guestOf, occupancy, OVERHEAD, schedule, type Manifest, type Network, type Spawn } from "./fleet";

const slot = (n: number) => ({ guestAddress: `10.${80 + n}.0.2`, stateDir: "", shareDir: "", outboxDir: "", unit: `agent-${n}.service` });

const m = (budget: number | null): Manifest => ({
  flake: "",
  owner: "matthew",
  memoryBudget: budget,
  slots: { "agent-0": slot(0), "agent-1": slot(1) },
  residents: { "brain-vm": { unit: "brain-vm.service", memory: 14336 } },
  templates: {
    coding: { memory: 4096, cores: 2, needsApproval: false, capNames: ["coding"] },
    big: { memory: 12288, cores: 4, needsApproval: false, capNames: [] },
  },
  bindings: { work: { shares: ["vault"] }, pepper: { shares: [] } },
  defaultAccount: "personal",
});

let n = 0;
const spawn = (template: string, state: Spawn["state"] = "queued", slot?: string): Spawn => ({
  id: `s${++n}`, template, task: "t", by: "user", account: "personal", state, slot, created: `2026-10-27T00:00:0${n}Z`,
});

test("queued spawns take free slots in order", () => {
  const a = spawn("coding"), b = spawn("coding");
  expect(schedule(m(null), [a, b], new Set()).start).toEqual([{ id: a.id, slot: "agent-0" }, { id: b.id, slot: "agent-1" }]);
});

test("a third waits for a slot", () => {
  const all = [spawn("coding", "running", "agent-0"), spawn("coding", "running", "agent-1"), spawn("coding")];
  const p = schedule(m(null), all, new Set(["agent-0.service", "agent-1.service"]));
  expect(p.start).toEqual([]);
  expect(p.waiting?.reason).toBe("every slot is busy");
});

test("past the budget a spawn waits, and so does everything behind it", () => {
  const budget = 14336 + 2 * (4096 + OVERHEAD) - 1;
  const a = spawn("coding"), b = spawn("coding"), c = spawn("coding");
  const p = schedule(m(budget), [a, b, c], new Set(["brain-vm.service"]));
  expect(p.start.map((s) => s.id)).toEqual([a.id]);
  expect(p.waiting?.id).toBe(b.id);
});

test("a resident that is down doesn't count", () => {
  const budget = 2 * (4096 + OVERHEAD);
  const p = schedule(m(budget), [spawn("coding"), spawn("coding")], new Set());
  expect(p.start.length).toBe(2);
});

test("a spawn bigger than the whole budget fails rather than waiting forever", () => {
  const s = spawn("big");
  const p = schedule(m(8192), [s], new Set());
  expect(p.fail).toEqual([{ id: s.id, error: `big needs ${12288 + OVERHEAD} MiB; the budget is 8192` }]);
});

test("an unknown template fails, and doesn't hold up the queue", () => {
  const bad = spawn("nope"), good = spawn("coding");
  const p = schedule(m(null), [bad, good], new Set());
  expect(p.fail.map((f) => f.id)).toEqual([bad.id]);
  expect(p.start.map((s) => s.id)).toEqual([good.id]);
});

test("a slot whose unit is still up isn't free, even with no spawn on it", () => {
  const s = spawn("coding");
  expect(schedule(m(null), [s], new Set(["agent-0.service"])).start).toEqual([{ id: s.id, slot: "agent-1" }]);
});

// Which account a spawn runs as, and which guest it boots.

test("a spawn runs as the account it was given, else the default", () => {
  expect(accountFor(m(null), "work")).toBe("work");
  expect(accountFor(m(null), null)).toBe("personal");
  expect(accountFor(m(null))).toBe("personal");
  expect(() => accountFor({ ...m(null), defaultAccount: null })).toThrow("which account?");
});

test("an account is a plain name, never a path", () => {
  expect(() => accountFor(m(null), "../../.ssh/id_ed25519")).toThrow("no account");
});

test("a brain this host has memory for boots with it; any other, its template's guest", () => {
  expect(guestOf(m(null), { ...spawn("coding"), brain: "work" })).toBe("coding+work");
  expect(guestOf(m(null), { ...spawn("coding"), brain: "pepper" })).toBe("coding");
  expect(guestOf(m(null), { ...spawn("coding"), brain: "garden" })).toBe("coding");
  expect(guestOf({ ...m(null), bindings: undefined }, { ...spawn("coding"), brain: "work" })).toBe("coding");
  expect(guestOf(m(null), spawn("coding"))).toBe("coding");
});

test("what every slot may reach: what they all allow, open if they all are, unknown if one doesn't say", () => {
  const net = (egress: Network["egress"], allowedDomains: string[], allowedDomainSuffixes: string[] = []): Network => ({ address: null, egress, allowedDomains, allowedDomainSuffixes, routedEgress: [] });
  const with2 = (a?: Network, b?: Network): Manifest => ({ ...m(null), slots: { "agent-0": { ...slot(0), network: a }, "agent-1": { ...slot(1), network: b } } });
  expect(egressOf(with2(net("allowlist", ["a.com", "b.com"], ["x.org"]), net("allowlist", ["b.com"], ["x.org"])))).toEqual({ open: false, domains: ["b.com"], suffixes: ["x.org"] });
  expect(egressOf(with2(net("open", []), net("allowlist", ["b.com"])))).toEqual({ open: false, domains: ["b.com"], suffixes: [] });
  expect(egressOf(with2(net("open", []), net("open", [])))).toEqual({ open: true, domains: [], suffixes: [] });
  expect(egressOf(with2(net("open", []), undefined))).toBeUndefined();
  expect(egressOf({ ...m(null), slots: {} })).toBeUndefined();
});

test("what's up: residents while their unit is, and each slot's spawn", () => {
  const a = spawn("coding", "running", "agent-1");
  const o = occupancy({ ...m(21504), residents: { "brain-vm": { unit: "brain-vm.service", memory: 14336, brain: "work" } } }, [a, spawn("coding")], new Set(["brain-vm.service"]));
  expect(o).toEqual({
    budget: 21504,
    used: 14336 + 4096 + OVERHEAD,
    residents: [{ name: "brain-vm", brain: "work", memory: 14336, up: true }],
    slots: [
      { name: "agent-0", spawn: null, template: null, brain: null, memory: null },
      { name: "agent-1", spawn: a.id, template: "coding", brain: null, memory: 4096 + OVERHEAD },
    ],
  });
  expect(occupancy(m(null), [], new Set()).residents[0]).toMatchObject({ brain: null, up: false });
});

test("each VM's config: a resident's own, a slot's as the template it runs", () => {
  const network = { address: "10.80.0.2", egress: "allowlist" as const, allowedDomains: ["api.anthropic.com"], allowedDomainSuffixes: [], routedEgress: [] };
  const base = m(null);
  const man: Manifest = {
    ...base,
    slots: { "agent-0": { ...slot(0), network }, "agent-1": { ...slot(1), network } },
    residents: { "brain-vm": { unit: "brain-vm.service", memory: 14336, brain: "work", account: "work", cores: 4, capNames: ["coding"], network } },
  };
  const a = { ...spawn("coding", "running", "agent-0"), brain: "work" };
  const o = occupancy(man, [a], new Set(["brain-vm.service"]));
  expect(o.residents[0].config).toEqual({ ...network, cores: 4, capabilities: ["coding"], account: "work" });
  expect(o.slots[0]).toMatchObject({ template: "coding", brain: "work" });
  expect(o.slots[0].config).toEqual({ ...network, cores: 2, capabilities: ["coding"], account: "personal", needsApproval: false });
  expect(o.slots[1].config).toEqual({ ...network, cores: null, capabilities: [], account: null });
  expect(occupancy(base, [], new Set()).residents[0].config).toBeUndefined();
});

test("a spawn sized bigger than its template counts at its own size", () => {
  const s = { ...spawn("coding", "running", "agent-0"), memory: 8192, cores: 4 };
  const o = occupancy(m(null), [s], new Set(["agent-0.service"]));
  expect(o.used).toBe(8192 + OVERHEAD);
  const p = schedule(m(8192 + OVERHEAD + 4096), [s, spawn("coding")], new Set(["agent-0.service"]));
  expect(p.waiting?.reason).toContain("needs");
});

test("past the host's offer a spawn fails", () => {
  const big = { ...spawn("coding"), memory: 9000 }, wide = { ...spawn("coding"), cores: 8 };
  const p = schedule({ ...m(null), offer: { memory: 8192, cores: 4 } }, [big, wide], new Set());
  expect(p.fail.map((f) => f.error)).toEqual(["asks for 9000 MiB; one VM here gets at most 8192", "asks for 8 cores; one VM here gets at most 4"]);
});

test("a shell of the spawner's never goes beside a brain's memory", () => {
  const s = { ...spawn("coding"), brain: "work", shell: { packages: ["ffmpeg"] } };
  expect(schedule(m(null), [s], new Set()).fail[0].error).toContain("for no brain");
});
