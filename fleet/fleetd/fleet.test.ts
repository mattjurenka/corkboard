// fleetd's scheduling: which queued spawns start, given slots, residents and
// the memory budget.   bun test fleet/fleetd
import { expect, test } from "bun:test";
import { accountFor, OVERHEAD, schedule, type Manifest, type Spawn } from "./fleet";

const slot = (n: number) => ({ guestAddress: `10.${80 + n}.0.2`, stateDir: "", shareDir: "", outboxDir: "", unit: `agent-${n}.service` });

const m = (budget: number | null): Manifest => ({
  flake: "",
  owner: "matthew",
  memoryBudget: budget,
  slots: { "agent-0": slot(0), "agent-1": slot(1) },
  residents: { "brain-vm": { unit: "brain-vm.service", memory: 14336 } },
  templates: {
    coding: { memory: 4096, cores: 2, needsApproval: false, brain: null, account: null, capNames: ["coding"] },
    big: { memory: 12288, cores: 4, needsApproval: false, brain: null, account: null, capNames: [] },
    "work-coding": { memory: 4096, cores: 2, needsApproval: true, brain: "work", account: "work", capNames: ["coding"] },
  },
  brains: { work: { account: "work" }, pepper: { account: "personal" } },
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

// Which account a spawn runs as.

test("a brain's template runs as the brain's account, whoever spawns it", () => {
  expect(accountFor(m(null), "work-coding", "user")).toBe("work");
  expect(accountFor(m(null), "work-coding", "pepper")).toBe("work");
});

test("and can't be made to run as another", () => {
  expect(() => accountFor(m(null), "work-coding", "user", "personal")).toThrow("runs as work");
});

test("a brainless template runs as the brain that spawned it", () => {
  expect(accountFor(m(null), "coding", "pepper")).toBe("personal");
  expect(accountFor(m(null), "coding", "work")).toBe("work");
});

test("or, spawned by the user, as asked, else the default", () => {
  expect(accountFor(m(null), "coding", "user", "work")).toBe("work");
  expect(accountFor(m(null), "coding", "user")).toBe("personal");
  expect(() => accountFor({ ...m(null), defaultAccount: null }, "coding", "user")).toThrow("which account?");
});

test("an account is a plain name, never a path", () => {
  expect(() => accountFor(m(null), "coding", "user", "../../.ssh/id_ed25519")).toThrow("no account");
});
