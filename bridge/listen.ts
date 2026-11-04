// A meeting heard as it's recorded (record.ts), or afterwards from its
// chunks. Each track's audio is cut into utterances where Silero hears
// speech; each utterance is transcribed by Whisper into a line, and given a
// speaker by its voice. The utterance still going on is transcribed too, now
// and then, while nothing else is waiting: the meeting's partial line, so
// what's being said shows as it's said.
//
// Speakers are told apart per track: a voice near one already heard is
// theirs, one far from all of them is someone new. On out they're Them, or
// Them 1, 2... once there's more than one; on in, whoever has said the most
// is Me, and the others are the room's.
//
// Without headphones the mic hears the speakers. record.ts cancels that
// echo in PipeWire, and what gets through is dropped here: a line on in that
// says what a line on out said at the same time, or in one of out's voices.

import { FRAME, RATE, Vad, voice, whisper } from "./transcribe";

export type Track = "out" | "in";
// Something said, on a track, in ms from the meeting's start; speaker is
// the track's voices' index.
export type Line = { track: Track; start: number; stop: number; text: string; speaker: number };
// A voice heard: the sum of its utterances' vectors, and how long it spoke.
export type Voice = { sum: number[]; ms: number };
export type Heard = {
  lines: Line[];
  voices: Record<Track, Voice[]>;
  // Who each track's voices are, by index.
  who: Record<Track, string[]>;
  // What's being said, not yet a line.
  partial: Partial<Record<Track, { start: number; text: string }>>;
  // Up to when each track is heard: what's after it is still to do.
  heard: Record<Track, number>;
};

const FRAME_MS = (FRAME / RATE) * 1000;
// Speech starts above ON and goes on until below OFF for HANG_MS.
const ON = 0.5;
const OFF = 0.35;
const HANG_MS = 600;
// Kept either side of an utterance.
const PAD_MS = 200;
// An utterance this long is cut where it's got to.
const MAX_MS = 20_000;
// Too short to be worth a line.
const MIN_MS = 300;
// Between partials of one utterance.
const PARTIAL_MS = 1000;
// A voice this near (cosine) one already heard is theirs.
const SAME = 0.5;
// Shorter, an utterance's voice is too unsure to start someone new.
const NEW_MS = 1500;
// An echo: on in within this of out saying the same.
const ECHO_MS = 2000;

const frames = (ms: number) => Math.round(ms / FRAME_MS);

type Utterance = { track: Track; start: number; stop: number; audio: Float32Array };

// One track's audio, cut into utterances.
class Ear {
  private vad = new Vad();
  private rest = new Float32Array(0);
  private pre: Float32Array[] = [];
  private utt: Float32Array[] | null = null;
  private start = 0;
  private quiet = 0;
  private lastPartial = 0;
  private work = Promise.resolve();

  constructor(
    readonly track: Track,
    private at: number,
    private said: (u: Utterance) => void,
    private saying: (u: Utterance | null) => void,
    private upTo: (ms: number) => void,
  ) {}

  // samples, the first at ms when given (from the meeting's start); what's
  // before what's been heard already is skipped.
  push(samples: Float32Array, ms?: number) {
    this.work = this.work.then(() => this.take(samples, ms));
    return this.work;
  }

  // The end of the audio: what's being said is said.
  end() {
    this.work = this.work.then(() => {
      if (this.utt) this.cut(this.utt.length);
    });
    return this.work;
  }

  private async take(samples: Float32Array, ms?: number) {
    if (ms !== undefined) {
      const due = this.at + (this.rest.length / RATE) * 1000;
      if (ms < due) samples = samples.subarray(Math.min(samples.length, Math.round(((due - ms) / 1000) * RATE)));
      else if (ms > due) {
        this.rest = new Float32Array(0);
        this.at = ms;
      }
    }
    let all = samples;
    if (this.rest.length) {
      all = new Float32Array(this.rest.length + samples.length);
      all.set(this.rest);
      all.set(samples, this.rest.length);
    }
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) await this.frame(all.slice(i, i + FRAME));
    this.rest = all.slice(i);
  }

  private async frame(f: Float32Array) {
    const p = await this.vad.next(f);
    this.at += FRAME_MS;
    if (!this.utt) {
      this.pre.push(f);
      if (this.pre.length > frames(PAD_MS)) this.pre.shift();
      if (p >= ON) {
        this.utt = this.pre;
        this.pre = [];
        this.start = this.at - this.utt.length * FRAME_MS;
        this.quiet = 0;
        this.lastPartial = this.at;
      } else {
        this.upTo(this.at);
      }
      return;
    }
    this.utt.push(f);
    this.quiet = p < OFF ? this.quiet + 1 : 0;
    if (this.quiet >= frames(HANG_MS)) this.cut(this.utt.length - this.quiet + frames(PAD_MS));
    else if (this.utt.length * FRAME_MS >= MAX_MS) this.cut(this.utt.length);
    else if (this.at - this.lastPartial >= PARTIAL_MS) {
      this.lastPartial = this.at;
      this.saying(this.utterance(this.utt.length));
    }
  }

  private utterance(n: number): Utterance {
    const audio = new Float32Array(n * FRAME);
    for (let i = 0; i < n; i++) audio.set(this.utt![i], i * FRAME);
    return { track: this.track, start: Math.round(this.start), stop: Math.round(this.start + n * FRAME_MS), audio };
  }

  // The utterance, its first n frames; still speaking past them (a long
  // one), the next starts there.
  private cut(n: number) {
    const u = this.utterance(Math.min(n, this.utt!.length));
    const after = this.quiet ? [] : this.utt!.slice(n);
    this.saying(null);
    if (u.stop - u.start >= MIN_MS) this.said(u);
    this.upTo(u.stop);
    this.utt = after.length ? after : null;
    this.start = u.stop;
    this.lastPartial = this.at;
    this.pre = [];
  }
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

// How much of the shorter one the other says too.
function alike(a: string, b: string) {
  const x = words(a), y = new Set(words(b));
  if (!x.length || !y.size) return 0;
  return x.filter((w) => y.has(w)).length / Math.min(x.length, y.size);
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const near = (v: Float32Array, voice: Voice) => dot(v, voice.sum) / (Math.hypot(...voice.sum) || 1);

// Someone new: a voice no one has, one that turned out to be echo's or
// another.
function fresh(voices: Voice[], n: number) {
  const i = voices.findIndex((x) => x.ms <= 0);
  if (i >= 0) return i;
  return voices.push({ sum: Array(n).fill(0), ms: 0 }) - 1;
}

function who(voices: Record<Track, Voice[]>): Record<Track, string[]> {
  const out = voices.out.length > 1 ? voices.out.map((_, i) => `Them ${i + 1}`) : ["Them"];
  const me = voices.in.reduce((m, v, i) => (v.ms > voices.in[m].ms ? i : m), 0);
  let room = 0;
  return { out, in: voices.in.length ? voices.in.map((v, i) => (i === me ? "Me" : v.ms > 0 ? `Room ${++room}` : "")) : ["Me"] };
}

// A meeting's hearing: both tracks into heard, which changed() is told of.
// failed(), with why what was said couldn't be heard. Without partials,
// only lines: for a meeting heard afterwards, when no one's watching it said.
export function hear(heard: Heard, changed: () => void, failed: (err: Error) => void, partials = true) {
  heard.lines ??= [];
  heard.voices ??= { out: [], in: [] };
  heard.who ??= { out: [], in: [] };
  heard.partial ??= {};
  heard.heard ??= { out: 0, in: 0 };
  const said: Utterance[] = [];
  const saying: Partial<Record<Track, Utterance>> = {};
  // The voices of lines on in, until out has had its chance to show them echoes.
  const inVoices = new WeakMap<Line, Float32Array>();
  let busy = false;
  let idle: (() => void)[] = [];

  const ears = Object.fromEntries(
    (["out", "in"] as const).map((track) => [
      track,
      new Ear(
        track,
        heard.heard[track],
        (u) => {
          said.push(u);
          void next();
        },
        (u) => {
          if (u) {
            if (partials) saying[track] = u;
          } else {
            delete saying[track];
            if (heard.partial[track]) {
              delete heard.partial[track];
              changed();
            }
          }
          void next();
        },
        (ms) => {
          if (!said.some((u) => u.track === track)) heard.heard[track] = Math.max(heard.heard[track], ms);
        },
      ),
    ]),
  ) as Record<Track, Ear>;

  const echo = (line: Line, v?: Float32Array) =>
    heard.lines.some(
      (o) =>
        o.track === "out" &&
        o.start < line.stop + ECHO_MS &&
        line.start < o.stop + ECHO_MS &&
        ((alike(line.text, o.text) >= 0.6 && Math.min(words(line.text).length, words(o.text).length) >= 3) ||
          (v && near(v, heard.voices.out[o.speaker]) >= SAME)),
    );

  const add = async (u: Utterance) => {
    const text = await whisper(u.audio);
    if (!text) return;
    const v = u.stop - u.start >= 1000 ? await voice(u.audio) : undefined;
    const line: Line = { track: u.track, start: u.start, stop: u.stop, text, speaker: 0 };
    if (u.track === "in" && echo(line, v)) return;
    const voices = heard.voices[u.track];
    if (v) {
      let best = -1, how = -1;
      voices.forEach((x, i) => {
        const n = near(v, x);
        if (n > how) [best, how] = [i, n];
      });
      // Too short to be sure it's someone new: whoever it's nearest.
      line.speaker = how >= SAME || (best >= 0 && u.stop - u.start < NEW_MS) ? best : fresh(voices, v.length);
      const x = voices[line.speaker];
      for (let i = 0; i < v.length; i++) x.sum[i] += v[i];
      x.ms += u.stop - u.start;
      if (u.track === "in") inVoices.set(line, v);
    } else {
      // Too short to tell: whoever spoke last on the track.
      line.speaker = heard.lines.findLast((l) => l.track === u.track)?.speaker ?? 0;
    }
    let i = heard.lines.length;
    while (i > 0 && heard.lines[i - 1].start > line.start) i--;
    heard.lines.splice(i, 0, line);
    // Out, the echoes on in of what it said.
    if (u.track === "out") {
      heard.lines = heard.lines.filter((l) => {
        if (l.track !== "in" || !echo(l, inVoices.get(l))) return true;
        // Its voice was out's, not someone in the room.
        const x = heard.voices.in[l.speaker], v = inVoices.get(l);
        if (x && v) {
          x.ms -= l.stop - l.start;
          x.sum = x.ms > 0 ? x.sum.map((s, i) => s - v[i]) : x.sum.map(() => 0);
        }
        return false;
      });
    }
    heard.who = who(heard.voices);
  };

  // Utterances said first, in order; the partials when nothing is.
  async function next() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const u = said.shift();
        if (u) {
          try {
            await add(u);
            heard.heard[u.track] = Math.max(heard.heard[u.track], u.stop);
          } catch (err) {
            failed(err as Error);
          }
          changed();
          continue;
        }
        const track = (["out", "in"] as const).find((t) => saying[t]);
        if (!track) break;
        const p = saying[track]!;
        delete saying[track];
        const text = await whisper(p.audio).catch(() => "");
        // Not if it's been said since.
        if (said.some((u) => u.track === track && u.start === p.start) || heard.heard[track] > p.start) continue;
        heard.partial[track] = { start: p.start, text };
        changed();
      }
    } finally {
      busy = false;
      if (!said.length) for (const f of idle.splice(0)) f();
    }
  }

  return {
    ears,
    // Every utterance heard so far a line.
    async done() {
      await Promise.all(Object.values(ears).map((e) => e.end()));
      if (busy || said.length) await new Promise<void>((r) => idle.push(r));
      heard.partial = {};
      changed();
    },
  };
}
