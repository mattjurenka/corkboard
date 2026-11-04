// A meeting, recorded on this machine (.agent/plans/meetings.md):
//
//   corkboard-bridge record start    begin one, in the background; prints its directory
//   corkboard-bridge record stop     end it, its last chunks finished
//   corkboard-bridge record status   what's recording, as JSON (null when nothing is)
//   corkboard-bridge record finish DIR
//                                    transcribe what's left of one and send it
//                                    to Pepper, if its recorder didn't
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
//
// Each chunk is transcribed once it's cut (transcribe.ts), into the meeting's
// lines, so the transcript is there while the meeting goes on. Once it's
// stopped and the last chunks are done, the recorder sends the transcript to
// Pepper as a note, meeting-<id>, and exits. meeting.json's pid is the
// process working on it until then.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, signedIn, token } from "./cloud";
import { COMPILED, DATA_DIR, STATE_DIR } from "./dirs";
import { transcribe } from "./transcribe";

const CHUNK_MS = 30_000;
const OVERLAP_MS = 500;
const TRACKS = ["out", "in"] as const;
type Track = (typeof TRACKS)[number];

export const MEETINGS_DIR = join(DATA_DIR, "meetings");
const RECORDING = join(STATE_DIR, "recording.json");

const SELF = COMPILED ? [process.execPath] : [process.execPath, join(import.meta.dir, "main.ts")];

// started, and at: the same, in ms since the epoch.
export type Recording = { pid: number; id: string; dir: string; started: string; at: number };
export type Chunk = { track: Track; file: string; start: number; stop?: number; transcribed?: boolean };
// Something said, on a track, in ms from the meeting's start.
export type Line = { track: Track; start: number; stop: number; text: string };
// error: the recording failed; failed: transcribing or sending it did.
export type Meeting = {
  id: string;
  brain: string;
  started: string;
  stopped?: string;
  chunks: Chunk[];
  lines: Line[];
  pid?: number;
  transcribed?: string;
  sent?: string;
  error?: string;
  failed?: string;
};

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
  // Stopped once its last chunks are written; it stays to transcribe them.
  for (let i = 0; i < 100 && current(); i++) await sleep(100);
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

const saver = (dir: string, meeting: Meeting) => () => writeFileSync(join(dir, "meeting.json"), JSON.stringify(meeting, null, 2) + "\n");

// The chunks that are written and not yet transcribed, into the meeting's
// lines, in order of when they were said.
async function transcribeChunks(dir: string, meeting: Meeting, save: () => void) {
  for (const chunk of meeting.chunks) {
    if (chunk.stop === undefined || chunk.transcribed) continue;
    try {
      const said = await transcribe(join(dir, chunk.file));
      meeting.lines.push(...said.map((s) => ({ track: chunk.track, start: chunk.start + s.start, stop: chunk.start + s.stop, text: s.text })));
      meeting.lines.sort((a, b) => a.start - b.start);
      chunk.transcribed = true;
      delete meeting.failed;
    } catch (err) {
      meeting.failed = `transcribing: ${(err as Error).message}`;
    }
    save();
  }
}

const WHO: Record<Track, string> = { out: "Them", in: "Me" };

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};

// The transcript as Pepper reads it: who said what, and when.
function note(meeting: Meeting) {
  const started = new Date(meeting.started);
  const when = started.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const minutes = meeting.stopped ? Math.round((Date.parse(meeting.stopped) - started.getTime()) / 60_000) : 0;
  const body = [
    `# Meeting, ${when}`,
    "",
    `Recorded on this laptop for ${minutes} min. "Me" is its mic; "Them" is what it played (the others on a call).`,
    "",
    ...(meeting.lines.length ? meeting.lines.map((l) => `[${clock(l.start)}] ${WHO[l.track]}: ${l.text}`) : ["Nothing was said."]),
  ].join("\n");
  return { kind: "reference", title: `Meeting, ${when}`, body };
}

// Done with a stopped meeting: what's left transcribed, then sent to Pepper.
async function conclude(dir: string, meeting: Meeting, save: () => void) {
  await transcribeChunks(dir, meeting, save);
  if (meeting.chunks.some((c) => !c.transcribed)) return;
  meeting.transcribed ??= new Date().toISOString();
  if (!meeting.sent) {
    try {
      if (!signedIn()) throw new Error("this machine isn't signed in to corkboard");
      const res = await fetch(`${CLOUD}/api/notes/meeting-${meeting.id.toLowerCase()}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify(note(meeting)),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      meeting.sent = new Date().toISOString();
      delete meeting.failed;
    } catch (err) {
      meeting.failed = `sending to ${meeting.brain}: ${(err as Error).message}`;
    }
  }
  save();
}

// record finish DIR: a stopped meeting its recorder didn't get to the end of.
async function resume(dir: string) {
  const meeting = JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as Meeting;
  if (!meeting.stopped) throw new Error("it's still being recorded");
  if (meeting.pid && meeting.pid !== process.pid && alive(meeting.pid)) throw new Error("it's being transcribed");
  meeting.lines ??= [];
  meeting.brain ??= "pepper";
  meeting.pid = process.pid;
  const save = saver(dir, meeting);
  save();
  await conclude(dir, meeting, save);
  delete meeting.pid;
  save();
}

// record run DIR: the recorder itself, until SIGTERM, and then until what it
// recorded is transcribed and sent.
async function run(dir: string) {
  const t0 = Date.now();
  // Pepper's for now; which brain a meeting is for is to come (meetings.md).
  const meeting: Meeting = { id: dir.split("/").at(-1)!, brain: "pepper", started: new Date(t0).toISOString(), chunks: [], lines: [], pid: process.pid };
  const save = saver(dir, meeting);
  const live = new Map<Track, { proc: ReturnType<typeof record>; chunk: Chunk }>();
  let n = 0;
  // One transcription at a time, each after the chunks it's for.
  let transcribing = Promise.resolve();
  const later = () => (transcribing = transcribing.then(() => transcribeChunks(dir, meeting, save)));

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
    if (old.size) later();
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
    later();
    await transcribing;
    await conclude(dir, meeting, save);
    delete meeting.pid;
    save();
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
    } else if (op === "finish" && arg) {
      await resume(arg);
      process.exit(0);
    } else {
      console.error("usage: corkboard-bridge record start|stop|status|finish DIR");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
