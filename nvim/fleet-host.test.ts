// Setting a fleet up from the editor, in a real Neovim with a stand-in bridge:
// the Add a fleet host dialog's steps (corkboard/fleet_host.lua), and the
// fleet view's empty state and its forgetting an environment that's gone
// (corkboard/fleet.lua).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LUA = join(import.meta.dir, "lua");
const SCRIPT = join(mkdtempSync(join(tmpdir(), "corkboard-fleet-host-")), "run.lua");
// The bridge answers each op from input.answers ({ err } or a result) and
// keeps what it was asked; the page is what corkboard.notify was sent.
writeFileSync(
  SCRIPT,
  `
    package.path = ${JSON.stringify(LUA + "/?.lua;" + LUA + "/?/init.lua;")} .. package.path
    local input = vim.json.decode(io.read("*a"))
    local asked, sent = {}, {}
    package.loaded["corkboard.cards.cloud"] = {
      enabled = function() return true end,
      call_async = function(op, cb, ...)
        table.insert(asked, { op, ... })
        local a = table.remove(input.answers[op] or {}, 1) or {}
        cb(a.err, a.result)
      end,
    }
    local ui = require("corkboard")
    ui.attached = function() return true end
    ui.notify = function(method, s) table.insert(sent, { method, s }) end
    ui.toast = function(id, kind, text) table.insert(sent, { "toast", kind, text }) end
    local out = assert(loadstring(input.run))()
    io.write(vim.json.encode({ asked = asked, sent = sent, out = out }))`,
);

function run(answers: Record<string, unknown[]>, lua: string): { asked: unknown[][]; sent: [string, any, any?][]; out: any } {
  const r = Bun.spawnSync(["nvim", "--headless", "--clean", "-l", SCRIPT], { stdin: Buffer.from(JSON.stringify({ answers, run: lua })) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}
const steps = (sent: [string, any, any?][]) => sent.filter(([m]) => m === "corkboard.fleet_host").map(([, s]) => s);

test("what the host printed is certified, and the command to run there shown", () => {
  const r = run(
    { pair_status: [{ result: { account: true } }], fleet_certify: [{ err: "that has no device in it" }, { result: { name: "fleetd", device: "D", cert: "{}", command: "corkboard-fleet device cert <<'EOF'" } }] },
    `local h = require("corkboard.fleet_host")
     h.start() h.paste("nonsense") h.paste("ID BOX") h.cancel()`,
  );
  expect(steps(r.sent)).toEqual([
    { step: "paste" },
    { step: "waiting" },
    { step: "paste", error: "that has no device in it" },
    { step: "waiting" },
    { step: "cert", name: "fleetd", device: "D", command: "corkboard-fleet device cert <<'EOF'" },
    null,
  ]);
  expect(r.asked).toEqual([["pair_status"], ["fleet_certify", "nonsense"], ["fleet_certify", "ID BOX"]]);
});

test("a root under a passphrase is asked for it, and again when it's wrong", () => {
  const r = run(
    { pair_status: [{ result: { account: true, passphrase: true } }], fleet_certify: [{ err: "wrong passphrase" }, { result: { name: "fleetd", device: "D", command: "c" } }] },
    `local h = require("corkboard.fleet_host")
     h.start() h.passphrase("nope") h.paste("ID BOX") h.passphrase("right") h.paste("ID BOX")`,
  );
  expect(steps(r.sent).map((s) => [s.step, s.passphrase ?? false, s.error ?? ""])).toEqual([
    ["paste", true, ""],
    ["paste", false, ""],
    ["waiting", false, ""],
    ["paste", true, "wrong passphrase"],
    ["paste", false, ""],
    ["waiting", false, ""],
    ["cert", false, ""],
  ]);
  expect(r.asked.slice(1)).toEqual([["fleet_certify", "ID BOX", "nope"], ["fleet_certify", "ID BOX", "right"]]);
});

test("a machine in no account is told so, and nothing opens", () => {
  const r = run({ pair_status: [{ result: { account: false } }] }, `require("corkboard.fleet_host").start()`);
  expect(steps(r.sent)).toEqual([]);
});

const old = "2026-01-01T00:00:00Z";
const fleet = (environments: unknown[]) => ({ result: { environments, spawns: [], sessions: [], bridges: [] } });

test("the fleet view says there's no host until a fleetd is heard from", () => {
  const lua = `local f = require("corkboard.fleet") f.load() return f.state()`;
  expect(run({ fleet_get: [fleet([])] }, lua).out.empty).toBe(true);
  expect(run({ fleet_get: [fleet([{ name: "omni", seen: old }])] }, lua).out.empty).toBeUndefined();
  expect(run({ fleet_get: [{ err: "no Worker" }] }, lua).out.empty).toBeUndefined();
});

test("an environment not heard from is forgotten once that's a yes; one that's fresh isn't asked about", () => {
  const now = new Date().toISOString();
  const r = run(
    { fleet_get: [fleet([{ name: "omni", seen: old }, { name: "droplet", seen: now }]), fleet([{ name: "droplet", seen: now }])] },
    `local f = require("corkboard.fleet")
     f.load()
     f.forget("droplet")
     local fresh = f.state().asking
     f.forget("omni")
     local asking = f.state().asking
     f.answer(false)
     local after_no = f.state().asking
     f.forget()
     f.answer(true)
     return { fresh = fresh or false, asking = asking, after_no = after_no or false, names = vim.tbl_map(function(g) return g.name end, f.state().groups) }`,
  );
  expect(r.out).toEqual({ fresh: false, asking: { forget: "omni", task: "omni" }, after_no: false, names: ["droplet"] });
  expect(r.asked.filter(([op]) => op === "fleet_forget")).toEqual([["fleet_forget", "omni"]]);
  expect(r.sent.filter(([m]) => m === "toast").map(([, kind, text]) => [kind, text])).toEqual([["pending", "forgetting omni"], ["done", "forgot omni"]]);
});
