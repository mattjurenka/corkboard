// fleetd's sessions, as the phone and the fleet view are served them: which
// spawns are sessions, what each is doing by its inbox and its events, and
// what's said to one going in its inbox.   bun test fleet/fleetd
import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn } from "./fleet";

const dir = mkdtempSync(join(tmpdir(), "fleet-sessions-"));
const slot = { guestAddress: "", stateDir: join(dir, "agent-0"), shareDir: join(dir, "agent-0/share"), outboxDir: join(dir, "agent-0/outbox"), unit: "agent-0.service" };

let fleet: typeof import("./fleet");
let sessions: typeof import("./sessions");

beforeAll(async () => {
  process.env.CORKBOARD_FLEET_STATE = join(dir, "fleet");
  process.env.CORKBOARD_FLEET_MANIFEST = join(dir, "fleet.json");
  process.env.CORKBOARD_STATE_DIR = join(dir, "state");
  writeFileSync(
    process.env.CORKBOARD_FLEET_MANIFEST,
    JSON.stringify({ flake: "", owner: "matthew", memoryBudget: null, slots: { "agent-0": slot }, residents: {}, templates: { coding: { memory: 1, cores: 1, needsApproval: false, capNames: [] } }, defaultAccount: "personal" }),
  );
  mkdirSync(slot.shareDir, { recursive: true });
  mkdirSync(slot.outboxDir, { recursive: true });
  fleet = await import("./fleet");
  if (!fleet.SPAWNS.startsWith(dir)) throw new Error("fleet's paths aren't the test's");
  sessions = await import("./sessions");
});

const spawn = (s: Partial<Spawn>): Spawn => {
  const x: Spawn = { id: "s1", template: "coding", task: "Look at the flaky test\nand more", by: "user", account: "personal", state: "running", slot: "agent-0", created: "2026-11-20T00:00:00Z", interactive: true, ...s };
  fleet.write(x);
  return x;
};
const inbox = () => readdirSync(join(slot.shareDir, "inbox")).sort().map((f) => readFileSync(join(slot.shareDir, "inbox", f), "utf8"));
const events = (...lines: object[]) => writeFileSync(join(slot.outboxDir, "events.jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""));

test("only a running session in a slot is one, named by its task's first line", () => {
  spawn({ repo: "/home/me/corkboard", remote: { board: "proj", card: "TASK-3", agent: "a", token: null } });
  spawn({ id: "s2", interactive: false });
  spawn({ id: "s3", state: "done" });
  spawn({ id: "s4", slot: "agent-9" });
  const [s, ...rest] = sessions.list();
  expect(rest).toEqual([]);
  expect(s).toMatchObject({ key: "s1", name: "Look at the flaky test", state: "starting", project: "corkboard", vm: "agent-0", role: "coding", spawn: "s1", card: "TASK-3", since: expect.any(Number) });
  expect(s.transcript).toBeUndefined();
});

test("it's working while it has more messages than results, and idle when it has answered them", async () => {
  sessions.post(slot.shareDir, sessions.message("first"));
  events({ type: "system" });
  expect(sessions.list()[0].state).toBe("working");
  // An interrupt isn't a message.
  expect(await sessions.say("s1", "", ["esc"])).toEqual({ ok: true });
  events({ type: "system" }, { type: "result", result: "ok" });
  expect(sessions.list()[0].state).toBe("idle");
  expect(await sessions.say("s1", "and the other one", [])).toEqual({ ok: true });
  expect(sessions.list()[0].state).toBe("working");
  const sent = inbox().map((l) => JSON.parse(l));
  expect(sent[1]).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
  expect(sent[2]).toEqual({ type: "user", message: { role: "user", content: "and the other one" } });
});

test("its transcript is its newest log, not a subagent's", () => {
  const project = join(slot.outboxDir, "projects/-work");
  mkdirSync(join(project, "sub"), { recursive: true });
  writeFileSync(join(project, "old.jsonl"), "{}\n");
  writeFileSync(join(project, "new.jsonl"), "{}\n");
  writeFileSync(join(project, "sub/agent.jsonl"), "{}\n");
  utimesSync(join(project, "old.jsonl"), new Date(1000), new Date(1000));
  expect(sessions.list()[0].transcript).toBe(join(project, "new.jsonl"));
});

test("a question it asked is answered in words, as a message, once it has asked one", async () => {
  const log = join(slot.outboxDir, "projects/-work/new.jsonl");
  const record = (type: string, content: unknown) => JSON.stringify({ type, uuid: crypto.randomUUID(), timestamp: "2026-11-22T00:00:00Z", message: { role: type, content } }) + "\n";
  writeFileSync(log, record("user", "which?"));
  expect(await sessions.say("s1", "", [], [{ picks: [0] }])).toEqual({ error: "it isn't asking anything" });
  const questions = [
    { header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
    { header: "", question: "Which sizes?", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }] },
  ];
  writeFileSync(log, record("user", "which?") + record("assistant", [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions } }]) + record("user", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "no one to ask" }]));
  const before = inbox().length;
  expect(await sessions.say("s1", "", [], [{ picks: [2] }, { picks: [] }])).toEqual({ error: "question 1's options are 0 to 1" });
  expect(await sessions.say("s1", "", [], [{ picks: [0, 1] }, { picks: [0] }])).toEqual({ error: "question 1 takes one answer" });
  expect(await sessions.say("s1", "", [], [{ picks: [0] }])).toEqual({ error: "answers must be a list, one for each of its 2 questions" });
  expect(await sessions.say("s1", "", [], [{ picks: [], other: "Green" }, { picks: [0, 1], other: "XL" }])).toEqual({ ok: true });
  expect(inbox().length).toBe(before + 1);
  expect(JSON.parse(inbox().at(-1)!)).toEqual({ type: "user", message: { role: "user", content: "Colour: Green\nWhich sizes?: S, M, XL" } });
});

test("one asked to finish is stopping, and takes nothing more; one gone is missing", async () => {
  spawn({ ending: new Date().toISOString() });
  expect(sessions.list()[0].state).toBe("stopping");
  const before = inbox().length;
  expect(await sessions.say("s1", "wait", [])).toEqual({ error: "that session is finishing" });
  expect(await sessions.say("s2", "hello", [])).toEqual({ error: "that session has ended", missing: true });
  expect(await sessions.say("s1", "", [], [{ picks: [0] }])).toEqual({ error: "that session is finishing" });
  expect(inbox().length).toBe(before);
});

test("the inbox is a file a message, and END ends it", () => {
  const m = fleet.manifest();
  sessions.end(m, fleet.read("s1")!);
  expect(inbox().at(-1)).toBe("END\n");
  // Never a half-written one: each is renamed into place.
  expect(readdirSync(join(slot.shareDir, "inbox")).every((f) => /^\d+$/.test(f))).toBe(true);
});
