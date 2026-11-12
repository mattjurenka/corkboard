// A meeting, recorded on this machine (.agent/plans/meetings.md):
//
//   corkboard-bridge record start    begin one, in the background; prints its directory
//   corkboard-bridge record stop     end it, its last chunks finished
//   corkboard-bridge record status   what's recording, as JSON (null when nothing is)
//   corkboard-bridge record finish DIR
//                                    hear what's left of one and send it
//                                    to Pepper, if its recorder didn't
//   corkboard-bridge record propose DIR
//                                    propose its action items again
//   corkboard-bridge record accept DIR '[{"i":0,"board":"...","title":"..."}]'
//                                    make proposals into cards
//   corkboard-bridge record drop DIR I
//                                    turn proposal I down
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
// The mic is recorded through PipeWire's echo canceller, which takes what
// the speakers play out of it: a pipewire of the recorder's own, so the
// default mic stays as it is. Without it (an older PipeWire), the plain mic.
//
// The recorder is its own process (record run), so a bridge restarted mid-
// meeting doesn't end it. STATE_DIR/recording.json says which one is running.
//
// Each track is also streamed, raw, to the meeting's hearing (listen.ts):
// what's said is in the meeting's lines a moment after, and what's being
// said in its partial. Once it's stopped and the last of it is heard, the
// recorder sends the transcript to Pepper as a note, meeting-<id>, has
// its action items proposed (propose.ts), and exits. meeting.json's pid is the process working on it until then. The
// chunks are what `record finish` hears it again from.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED, DATA_DIR, STATE_DIR } from "./dirs";
import { type Heard, hear } from "./listen";
import { nodeApi } from "./node/local";
import { type Board, type Proposal, accept, propose } from "./propose";
import { decode, RATE } from "./transcribe";

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
// error: the recording failed; failed: transcribing or sending it did.
// transcribed: when all of it was heard. proposed: when its action items
// were, and unproposed why they weren't.
export type Meeting = Heard & {
  id: string;
  brain: string;
  started: string;
  stopped?: string;
  chunks: Chunk[];
  pid?: number;
  transcribed?: string;
  sent?: string;
  error?: string;
  failed?: string;
  proposals?: Proposal[];
  boards?: Board[];
  proposed?: string;
  unproposed?: string;
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
  // Stopped once its last chunks are written; it stays to hear the rest.
  for (let i = 0; i < 100 && current(); i++) await sleep(100);
  return r;
}

// The echo-cancelled mic, while the recorder's canceller is running.
const AEC = "corkboard-aec-source";

// The canceller: its reference is the default sink's monitor, and its source
// is kept from being anyone's default mic.
function canceller(dir: string) {
  const conf = join(dir, "aec.conf");
  writeFileSync(conf, `context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.* = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-echo-cancel
    args = {
      library.name = aec/libspa-aec-webrtc
      monitor.mode = true
      audio.rate = ${RATE}
      audio.channels = 1
      capture.props = { node.name = corkboard-aec-capture node.passive = true }
      sink.props = { node.name = corkboard-aec-reference node.passive = true }
      source.props = { node.name = ${AEC} node.description = "corkboard: mic, echo cancelled" priority.session = 0 priority.driver = 0 }
    }
  }
]
`);
  return Bun.spawn(["pipewire", "-c", conf], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
}

const has = (node: string) => (spawnSync("pw-link", ["-o"], { encoding: "utf8" }).stdout ?? "").includes(`${node}:`);

const capture = (track: Track, target?: string) =>
  track === "out" ? ["-P", "{ stream.capture.sink=true node.name=corkboard-out }"] : ["-P", "{ node.name=corkboard-in }", ...(target ? ["--target", target] : [])];

// One track's pw-record, into file.
function record(track: Track, file: string, target?: string) {
  return Bun.spawn(["pw-record", "--rate", String(RATE), "--channels", "1", "--format", "opus", "--container", "oga", ...capture(track, target), file], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
}

// One track's samples, as they're recorded, to push(), with when (in ms from
// t0) the first of them was, and again after a gap: a sink with nothing to
// play sends nothing, and a pw-record that stopped short is started again.
// Until stop().
const GAP_MS = 300;
function stream(track: Track, t0: number, push: (samples: Float32Array, ms?: number) => Promise<void>, target?: string) {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      proc = Bun.spawn(["pw-record", "--raw", "--format", "f32", "--rate", String(RATE), "--channels", "1", ...capture(track, target), "-"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      });
      let rest = new Uint8Array(0);
      let at = -Infinity;
      for await (const bytes of proc.stdout as ReadableStream<Uint8Array>) {
        let all = bytes;
        if (rest.length) {
          all = new Uint8Array(rest.length + bytes.length);
          all.set(rest);
          all.set(bytes, rest.length);
        }
        const n = all.length >> 2;
        const samples = new Float32Array(all.slice(0, n * 4).buffer);
        rest = all.slice(n * 4);
        if (!samples.length) continue;
        const ms = Date.now() - t0 - (samples.length / RATE) * 1000;
        const gap = ms > at + GAP_MS;
        if (gap) at = ms;
        at += (samples.length / RATE) * 1000;
        void push(samples, gap ? ms : undefined);
      }
      await proc.exited;
      if (!stopped) await sleep(1000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      proc?.kill("SIGINT");
      await done;
    },
    kill: () => proc?.kill("SIGINT"),
  };
}

const saver = (dir: string, meeting: Meeting) => () => writeFileSync(join(dir, "meeting.json"), JSON.stringify(meeting, null, 2) + "\n");

// A meeting's hearing, into it.
const hearing = (meeting: Meeting, save: () => void, partials = true) =>
  hear(
    meeting,
    save,
    (err) => {
      meeting.failed = `transcribing: ${err.message}`;
      save();
    },
    partials,
  );

const WHO: Record<Track, string> = { out: "Them", in: "Me" };

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};

const whenOf = (meeting: Meeting) =>
  new Date(meeting.started).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// The transcript as Pepper reads it: who said what, and when.
function note(meeting: Meeting) {
  const started = new Date(meeting.started);
  const when = whenOf(meeting);
  const minutes = meeting.stopped ? Math.round((Date.parse(meeting.stopped) - started.getTime()) / 60_000) : 0;
  const body = [
    `# Meeting, ${when}`,
    "",
    `Recorded on this laptop for ${minutes} min. "Me" is whoever said the most into its mic, and "Room 1", "Room 2"... anyone else it heard; "Them" is what it played (the others on a call), "Them 1", "Them 2"... when there were more than one.`,
    "",
    ...(meeting.lines.length
      ? meeting.lines.map((l) => `[${clock(l.start)}] ${meeting.who?.[l.track]?.[l.speaker] || WHO[l.track]}: ${l.text}`)
      : ["Nothing was said."]),
  ].join("\n");
  return { kind: "reference", title: `Meeting, ${when}`, body };
}

// Its action items, proposed again: those already made cards are kept.
async function proposeFor(meeting: Meeting, save: () => void) {
  try {
    const { proposals, boards } = await propose(meeting, note(meeting).body);
    meeting.proposals = [...(meeting.proposals ?? []).filter((p) => p.card), ...proposals];
    meeting.boards = boards;
    meeting.proposed = new Date().toISOString();
    delete meeting.unproposed;
  } catch (err) {
    meeting.unproposed = (err as Error).message;
  }
  save();
}

// Done with a stopped meeting, all of it heard: sent to its brain's notes,
// and its action items proposed.
async function conclude(meeting: Meeting, save: () => void) {
  meeting.transcribed ??= new Date().toISOString();
  if (!meeting.sent) {
    try {
      await nodeApi("PUT", `/brains/${encodeURIComponent(meeting.brain)}/notes/meeting-${meeting.id.toLowerCase()}`, note(meeting));
      meeting.sent = new Date().toISOString();
      delete meeting.failed;
    } catch (err) {
      meeting.failed = `sending to ${meeting.brain}: ${(err as Error).message}`;
    }
  }
  save();
  if (!meeting.proposed && meeting.lines.length) await proposeFor(meeting, save);
}

// A meeting someone else isn't working on, for the ops below.
function open(dir: string) {
  const meeting = JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as Meeting;
  if (meeting.pid && meeting.pid !== process.pid && alive(meeting.pid)) throw new Error("it's being transcribed");
  return { meeting, save: saver(dir, meeting) };
}

// record propose DIR
async function repropose(dir: string) {
  const { meeting, save } = open(dir);
  if (!meeting.transcribed) throw new Error("it isn't transcribed yet");
  meeting.pid = process.pid;
  save();
  await proposeFor(meeting, save);
  delete meeting.pid;
  save();
  if (meeting.unproposed) throw new Error(meeting.unproposed);
}

// record accept DIR PICKS: each proposal picked made a card, on the board
// and with the title it was given.
async function acceptAll(dir: string, picks: { i: number; board: string; title?: string }[]) {
  const { meeting, save } = open(dir);
  const errors: string[] = [];
  for (const { i, board, title } of picks) {
    const p = meeting.proposals?.[i];
    if (!p || p.card) continue;
    try {
      await accept(meeting, p, board, title?.trim() || p.title, whenOf(meeting), clock(p.at));
      save();
    } catch (err) {
      errors.push(`${p.title}: ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

// record drop DIR I
function drop(dir: string, i: number) {
  const { meeting, save } = open(dir);
  const p = meeting.proposals?.[i];
  if (p && !p.card) p.dropped = true;
  save();
}

// record finish DIR: a stopped meeting its recorder didn't get to the end of.
async function resume(dir: string) {
  const meeting = JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as Meeting;
  if (!meeting.stopped) throw new Error("it's still being recorded");
  if (meeting.pid && meeting.pid !== process.pid && alive(meeting.pid)) throw new Error("it's being transcribed");
  meeting.brain ??= "pepper";
  meeting.pid = process.pid;
  // Heard before there was a hearing: again, from the start.
  if (!meeting.heard) meeting.lines = [];
  const save = saver(dir, meeting);
  save();
  if (!meeting.transcribed) {
    // Each track's chunks in order; the hearing skips their overlaps, and
    // what it had heard already.
    const h = hearing(meeting, save, false);
    await Promise.all(
      TRACKS.map(async (track) => {
        for (const chunk of meeting.chunks.filter((c) => c.track === track)) {
          const file = join(dir, chunk.file);
          if (existsSync(file)) await h.ears[track].push(await decode(file), chunk.start);
        }
      }),
    );
    await h.done();
  }
  await conclude(meeting, save);
  delete meeting.pid;
  save();
}

// record run DIR: the recorder itself, until SIGTERM, and then until what it
// recorded is transcribed and sent.
async function run(dir: string) {
  const t0 = Date.now();
  // Pepper's for now; which brain a meeting is for is to come (meetings.md).
  const meeting: Meeting = {
    id: dir.split("/").at(-1)!,
    brain: "pepper",
    started: new Date(t0).toISOString(),
    chunks: [],
    lines: [],
    voices: { out: [], in: [] },
    who: { out: [], in: [] },
    partial: {},
    heard: { out: 0, in: 0 },
    pid: process.pid,
  };
  const save = saver(dir, meeting);
  const live = new Map<Track, { proc: ReturnType<typeof record>; chunk: Chunk }>();
  let n = 0;

  const aec = canceller(dir);
  for (let i = 0; i < 20 && !has(AEC) && aec.exitCode === null; i++) await sleep(100);
  const target = has(AEC) ? AEC : undefined;
  if (!target) aec.kill();
  const h = hearing(meeting, save);
  const streams = TRACKS.map((track) => stream(track, t0, (s, ms) => h.ears[track].push(s, ms), target));

  const cut = async () => {
    const old = new Map(live);
    for (const track of TRACKS) {
      const file = `${track}-${String(n).padStart(3, "0")}.oga`;
      const chunk: Chunk = { track, file, start: Date.now() - t0 };
      live.set(track, { proc: record(track, join(dir, file), target), chunk });
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

  // However this ends, its pw-records and canceller do too.
  process.on("exit", () => {
    for (const { proc } of live.values()) proc.kill("SIGINT");
    for (const s of streams) s.kill();
    aec.kill();
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
    await Promise.all([finish(live), ...streams.map((s) => s.stop())]);
    aec.kill();
    meeting.stopped = new Date().toISOString();
    save();
    rmSync(RECORDING, { force: true });
    await h.done();
    await conclude(meeting, save);
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
    } else if (op === "propose" && arg) {
      await repropose(arg);
    } else if (op === "accept" && arg && args[2]) {
      await acceptAll(arg, JSON.parse(args[2]));
    } else if (op === "drop" && arg && args[2]) {
      drop(arg, Number(args[2]));
    } else {
      console.error("usage: corkboard-bridge record start|stop|status|finish DIR|propose DIR|accept DIR PICKS|drop DIR I");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
