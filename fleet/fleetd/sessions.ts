// fleetd's sessions: the interactive spawns running in its slots, served to
// the phone and the fleet view as a bridge's are (bridge/sessions.ts), each
// by its spawn's id. The guest (fleet/guest/slot.nix) runs Claude Code on
// stream-json: what's typed goes in the slot's inbox as a message, esc as
// an interrupt; its conversation is read from the logs it writes to
// the slot's outbox; and whether it's at work is what it was sent against
// how many turns it has finished.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { bridgeId, serve, type Hosted } from "../../bridge/sessions";
import { manifest, spawns, type Manifest, type Spawn } from "./fleet";
import { ENVIRONMENT } from "./queue";

// A message to the session, as its input takes them.
export const message = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

// The inbox is a file a line, named 0, 1, 2, ... in the order sent, never
// changed once there: the share caches what the guest has read of a file
// for good, so it would never see a line appended, but it does see a name
// that wasn't there before.
const inbox = (shareDir: string) => join(shareDir, "inbox");
const sent = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+$/.test(f)) : []);
export function post(shareDir: string, line: string) {
  const dir = inbox(shareDir);
  mkdirSync(dir, { recursive: true });
  const n = sent(dir).length;
  writeFileSync(join(dir, `.${n}`), line);
  renameSync(join(dir, `.${n}`), join(dir, String(n)));
}
const outbox = (m: Manifest, s: Spawn) => m.slots[s.slot!].outboxDir;

// The line that ends its input: it finishes the turn it's on and exits.
export function end(m: Manifest, s: Spawn) {
  post(m.slots[s.slot!].shareDir, "END\n");
}

// The newest log of its own (not a subagent's) in the outbox.
function transcript(dir: string): string | undefined {
  const root = join(dir, "projects");
  if (!existsSync(root)) return undefined;
  let best: { path: string; at: number } | undefined;
  for (const project of readdirSync(root)) {
    const d = join(root, project);
    for (const f of existsSync(d) && statSync(d).isDirectory() ? readdirSync(d) : []) {
      if (!f.endsWith(".jsonl")) continue;
      const at = statSync(join(d, f)).mtimeMs;
      if (!best || at > best.at) best = { path: join(d, f), at };
    }
  }
  return best?.path;
}

// Lines of a file that pass a test, counted again only when it grows.
const counted = new Map<string, { size: number; n: number }>();
function count(path: string, test: (line: string) => boolean): number {
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  const was = counted.get(path);
  if (was?.size === size) return was.n;
  const n = readFileSync(path, "utf8").split("\n").filter(test).length;
  counted.set(path, { size, n });
  return n;
}

function state(m: Manifest, s: Spawn): string {
  const events = join(outbox(m, s), "events.jsonl");
  if (!existsSync(events) || statSync(events).size === 0) return "starting";
  const dir = inbox(m.slots[s.slot!].shareDir);
  const asked = sent(dir).filter((f) => readFileSync(join(dir, f), "utf8").startsWith('{"type":"user"')).length;
  const done = count(events, (l) => l.includes('"type":"result"'));
  return asked > done ? "working" : "idle";
}

// When each came to the state it's in.
const since = new Map<string, { state: string; at: number }>();

function list(): Hosted[] {
  const m = manifest();
  return spawns()
    .filter((s) => s.interactive && s.state === "running" && s.slot && m.slots[s.slot])
    .map((s) => {
      const st = s.ending ? "stopping" : state(m, s);
      const was = since.get(s.id);
      if (was?.state !== st) since.set(s.id, { state: st, at: Date.now() });
      const path = transcript(outbox(m, s));
      return {
        key: s.id,
        name: s.task.split("\n")[0].trim().slice(0, 80) || `${s.template} session`,
        state: st,
        project: s.repo ? basename(s.repo) : "",
        since: since.get(s.id)!.at,
        vm: s.slot,
        role: s.template,
        spawn: s.id,
        ...(s.remote && { card: s.remote.card }),
        ...(path && { transcript: path }),
      };
    });
}

async function say(key: string, text: string, keys: string[]) {
  const m = manifest();
  const s = spawns().find((x) => x.id === key && x.interactive && x.state === "running" && x.slot);
  if (!s) return { error: "that session has ended", missing: true };
  if (s.ending) return { error: "that session is finishing" };
  const share = m.slots[s.slot!].shareDir;
  if (text) post(share, message(text));
  if (keys.includes("esc")) post(share, JSON.stringify({ type: "control_request", request_id: `esc-${Date.now()}`, request: { subtype: "interrupt" } }) + "\n");
  watched();
  return { ok: true };
}

const watchers = new Set<() => void>();
let last = "";
// Whenever what they are or what they're doing changes.
function watched() {
  const now = JSON.stringify(list().map(({ since: _, ...s }) => s));
  if (now === last) return;
  last = now;
  for (const fn of watchers) fn();
}

export function serveSessions() {
  if (process.env.CORKBOARD_REMOTE_SESSIONS === "0") return;
  setInterval(() => {
    try {
      watched();
    } catch (e) {
      console.error("fleetd sessions:", (e as Error).message);
    }
  }, 1000);
  serve(bridgeId(`fleetd-${hostname()}`), ENVIRONMENT, { list, watch: (fn) => watchers.add(fn), say });
}
