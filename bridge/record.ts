// A meeting, recorded on this machine (.agent/plans/meetings.md):
//
//   corkboard-bridge record start    begin one, in the background; prints its directory
//   corkboard-bridge record stop     end it, its last chunks finished
//   corkboard-bridge record status   what's recording, as JSON (null when nothing is)
//
// Two tracks, kept apart: out, what this machine plays (the default sink's
// monitor: the other people on a call), and in, the mic (you, the room).
// Each is pw-record's 16 kHz mono Ogg Opus, cut into chunks about CHUNK_MS
// long, in DATA_DIR/meetings/<id>/{out,in}-NNN.oga. meeting.json beside
// them lists each chunk and when it started, in ms from the meeting's start.
//
// A chunk's next is started before it's stopped, so the tracks have no gaps,
// only an overlap of OVERLAP_MS. Recording follows the default devices:
// headphones plugged in mid-call are the next chunk's.
//
// The recorder is its own process (record run), so a bridge restarted mid-
// meeting doesn't end it. STATE_DIR/recording.json says which one is running.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED, DATA_DIR, STATE_DIR } from "./dirs";

const CHUNK_MS = 30_000;
const OVERLAP_MS = 500;
const TRACKS = ["out", "in"] as const;
type Track = (typeof TRACKS)[number];

export const MEETINGS_DIR = join(DATA_DIR, "meetings");
const RECORDING = join(STATE_DIR, "recording.json");

const SELF = COMPILED ? [process.execPath] : [process.execPath, join(import.meta.dir, "main.ts")];

// started, and at: the same, in ms since the epoch.
export type Recording = { pid: number; id: string; dir: string; started: string; at: number };
export type Chunk = { track: Track; file: string; start: number; stop?: number };
export type Meeting = { id: string; started: string; stopped?: string; chunks: Chunk[]; error?: string };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The recording that's running, if one is.
export function current(): Recording | null {
  try {
    const r = JSON.parse(readFileSync(RECORDING, "utf8")) as Recording;
    if (alive(r.pid)) return r;
  } catch {}
  return null;
}

// 2026-11-02T14-03-07, local time: sorts, and reads as when it was.
function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function start(): Promise<Recording> {
  const running = current();
  if (running) return running;
  if (process.platform !== "linux") throw new Error("recording is only on Linux for now");
  if (spawnSync("pw-record", ["--version"], { stdio: "ignore" }).error) throw new Error("pw-record not found: recording needs PipeWire");
  const id = newId();
  const dir = join(MEETINGS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "recorder.log");
  const child = spawn(SELF[0], [...SELF.slice(1), "record", "run", dir], {
    detached: true,
    stdio: ["ignore", "ignore", openSync(log, "a")],
  });
  child.unref();
  // It's started when it has said so, or failed when it has gone.
  for (let i = 0; i < 50; i++) {
    const r = current();
    if (r?.id === id) return r;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  const why = existsSync(join(dir, "meeting.json")) ? (JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as Meeting).error : undefined;
  throw new Error(`the recorder didn't start${why ? `: ${why}` : `; see ${log}`}`);
}

export async function stop(): Promise<Recording | null> {
  const r = current();
  if (!r) return null;
  process.kill(r.pid, "SIGTERM");
  for (let i = 0; i < 100 && alive(r.pid); i++) await sleep(100);
  return r;
}

// One track's pw-record, into file.
function record(track: Track, file: string) {
  const props = track === "out" ? "{ stream.capture.sink=true node.name=corkboard-out }" : "{ node.name=corkboard-in }";
  return Bun.spawn(["pw-record", "--rate", "16000", "--channels", "1", "--format", "opus", "--container", "oga", "-P", props, file], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
}

// record run DIR: the recorder itself, until SIGTERM.
async function run(dir: string) {
  const t0 = Date.now();
  const meeting: Meeting = { id: dir.split("/").at(-1)!, started: new Date(t0).toISOString(), chunks: [] };
  const save = () => writeFileSync(join(dir, "meeting.json"), JSON.stringify(meeting, null, 2) + "\n");
  const live = new Map<Track, { proc: ReturnType<typeof record>; chunk: Chunk }>();
  let n = 0;

  const cut = async () => {
    const old = new Map(live);
    for (const track of TRACKS) {
      const file = `${track}-${String(n).padStart(3, "0")}.oga`;
      const chunk: Chunk = { track, file, start: Date.now() - t0 };
      live.set(track, { proc: record(track, join(dir, file)), chunk });
      meeting.chunks.push(chunk);
    }
    n++;
    save();
    if (old.size) await sleep(OVERLAP_MS);
    await finish(old);
  };
  // SIGINT is what has pw-record write the file's end.
  const finish = async (chunks: typeof live) => {
    for (const { proc } of chunks.values()) proc.kill("SIGINT");
    await Promise.all([...chunks.values()].map(async ({ proc, chunk }) => {
      await proc.exited;
      chunk.stop = Date.now() - t0;
    }));
    save();
  };

  // However this ends, its pw-records do too.
  process.on("exit", () => {
    for (const { proc } of live.values()) proc.kill("SIGINT");
  });

  await cut();
  await sleep(300);
  for (const [track, { proc }] of live) {
    if (proc.exitCode !== null) {
      meeting.error = `pw-record for ${track} exited (${proc.exitCode})`;
      save();
      process.exit(1);
    }
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(RECORDING, JSON.stringify({ pid: process.pid, id: meeting.id, dir, started: meeting.started, at: t0 } satisfies Recording) + "\n");

  let stopping = false;
  const timer = setInterval(() => void (stopping || cut()), CHUNK_MS);
  const end = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await finish(live);
    meeting.stopped = new Date().toISOString();
    save();
    rmSync(RECORDING, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

export async function cli(args: string[]) {
  const [op, arg] = args;
  try {
    if (op === "start") {
      const r = await start();
      console.log(r.dir);
    } else if (op === "stop") {
      const r = await stop();
      console.log(r ? r.dir : "not recording");
    } else if (op === "status") {
      console.log(JSON.stringify(current()));
    } else if (op === "run" && arg) {
      await run(arg);
    } else {
      console.error("usage: corkboard-bridge record start|stop|status");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
