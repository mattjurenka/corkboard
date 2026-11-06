// What the avatar says: Claude's markdown made into sentences, each said by
// Kokoro (the bridge's /speech, or else kokoro.worker.ts in the page) a
// sentence ahead of the one playing, and where
// in it the voice is, which the mouth and the subtitles follow. How open the
// mouth is comes from how loud the audio is; its shape from the phoneme the
// voice is on, as Kokoro timed it (or, for a recording, the letter, taken to
// go evenly through where it isn't silent). Muted, or with no
// audio, a sentence is only timed, as if said. Each sentence of a line is
// said on its own, with a pause after it by its stop and the line's mood;
// some interjections are a real recording (voices/clips, from cicifyre's
// "Free Voice Clips Pack (Bright Female)", whose voice ours was grown from),
// and some are spelled the way Kokoro says them right. Sentences said ahead
// of time (bun run lines: the personas' lines for a click) are played from
// voices/said, and a line can be made ready before it's said (Voice.warm).

import { FRAME, type Timing } from "../../../bridge/kokoro-timing";

export type Viseme = "aa" | "ih" | "ou" | "ee" | "oh";

// How a line is meant, as the session says with it (the say tool's mood):
// its speed, and how long it stops after each sentence, as a share of the
// usual.
export type Mood = "happy" | "excited" | "teasing" | "annoyed" | "sulky" | "shy" | "sad" | "surprised";
const MOODS: Record<Mood, { speed: number; pause: number }> = {
  happy: { speed: 1.05, pause: 1 },
  excited: { speed: 1.12, pause: 0.7 },
  teasing: { speed: 1, pause: 1.3 },
  annoyed: { speed: 1.08, pause: 0.8 },
  sulky: { speed: 0.9, pause: 1.5 },
  shy: { speed: 0.92, pause: 1.4 },
  sad: { speed: 0.88, pause: 1.5 },
  surprised: { speed: 1.1, pause: 0.8 },
};
export const isMood = (m: unknown): m is Mood => typeof m === "string" && Object.hasOwn(MOODS, m);

// The pause after a sentence, in seconds, by how it ends.
const pause = (s: string) => (/(\.\.\.|…)$/.test(s) ? 0.6 : /\?$/.test(s) ? 0.4 : /!$/.test(s) ? 0.3 : /[.:]$/.test(s) ? 0.35 : 0.15);

// Interjections said on their own, as a sentence, that are a recording:
// one of a few takes. In the anime voice only: the recordings are hers.
const RECORDED: [RegExp, string][] = [
  [/^gasps?[.!]*$/i, "gasp"],
  [/^(a?(ha){2,}|(he){2,}|(ehe)+)[.!~]*$/i, "laugh"],
  [/^what[?!]+$/i, "what"],
  [/^why[?!]+$/i, "why"],
  [/^hey[!.]*$/i, "hey"],
];
const TAKES = 3;

// Words Kokoro says wrong, as it says them right; and a stutter ("H-hey")
// as the word, since it spells the letters out.
const RESPELT: [RegExp, string][] = [
  [/\bbaka\b/gi, "bah-kah"],
  [/\bow\b/gi, "owww"],
  [/\bhmph\b/gi, "hmmf"],
  [/\b(\w{1,2})-(?=\1)/gi, ""],
];
const respell = (s: string) => RESPELT.reduce((t, [re, to]) => t.replace(re, to), s);

// Kokoro's voices, the first the default.
export const VOICES = [
  "anime",
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_sky",
  "af_nova",
  "af_kore",
  "af_aoede",
  "af_jessica",
  "af_sarah",
  "af_river",
  "af_alloy",
  "bf_lily",
  "bf_isabella",
  "bf_alice",
  "bf_emma",
  "am_michael",
];

// Voices that are another said slower and played faster: pitched up, the
// whole voice, by pitch. Kokoro's speed 0.8 makes a sentence about 1.2 times
// as long, so a pitch of 1.2 leaves it as quick as it was. anime is our own
// (bridge/kokoro-voices.ts), as it is.
const PITCHED: Record<string, { voice: string; speed: number; pitch: number }> = {
  anime: { voice: "af_anime", speed: 1, pitch: 1 },
};

// What a persona's voice is put through, as it's played. ring: pitched up,
// as quick as it was, and multiplied by a low hum, with some of it as it was
// under that.
export type Effect = "ring";
const RING = { pitch: 1.35, hz: 45, dry: 0.4, gain: 2 / 1.4 };

type Synth = { samples?: Float32Array; rate?: number; error?: string } & Partial<Timing>;
export type Bridge = (path: string, init?: RequestInit) => Promise<Response>;
// The mouth from a time in a line's audio (seconds) until the next: its
// shape, closed if none, and how far it opens of what the loudness says.
type Mark = { t: number; shape: Viseme | null; open: number };
// When each sound of a sentence of the line is said in its audio, and then
// when it stops, its pauses aside; and its characters in the line.
type Span = { times: number[]; first: number; last: number };
type Clip = { buffer: AudioBuffer; loud: Float32Array; marks: Mark[]; spans: Span[] };
type Line = { text: string; from: string; mood?: Mood; clip?: Promise<Clip | null> };

// Characters a second, for a sentence said without audio.
const CPS = 14;
// Sentences longer than this are said in parts.
const LONG = 200;
// and ones longer than this a clause at a time where they can be, so the
// first is heard sooner; an item's first, longer than this, at its first
// clause, as that's made while nothing is playing.
const CLAUSE = 90;
const FIRST = 50;
// The loudness is taken this many times a second.
const LOUD_HZ = 60;
// How far ahead of the sound the mouth takes its shape, in seconds.
const LEAD = 0.04;
// How many sentences are made ahead of the one playing.
const AHEAD = 2;

export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|~~)/g, "")
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function sentences(md: string): string[] {
  const out: string[] = [];
  const parts = speakable(md).split(/(?<=[.!?:])\s+|\n+/).flatMap(clauses);
  const cut = parts[0]?.length > FIRST ? parts[0].search(/(?<=[,;—])\s+/) : -1;
  if (cut >= 12 && parts[0].length - cut >= 12) parts.splice(0, 1, parts[0].slice(0, cut), parts[0].slice(cut));
  for (const part of parts) {
    let s = part.trim();
    if (!s) continue;
    while (s.length > LONG) {
      const cut = s.lastIndexOf(" ", LONG);
      const at = cut > LONG / 2 ? cut : LONG;
      out.push(s.slice(0, at));
      s = s.slice(at).trim();
    }
    // A scrap goes with the one before it.
    if (out.length && (s.length < 12 || out[out.length - 1].length < 12) && out[out.length - 1].length + s.length < LONG) {
      out[out.length - 1] += " " + s;
    } else out.push(s);
  }
  return out;
}

function clauses(s: string): string[] {
  if (s.length <= CLAUSE) return [s];
  const out = [""];
  for (const c of s.split(/(?<=[,;—])\s+/)) {
    if (out[out.length - 1] && out[out.length - 1].length + c.length >= CLAUSE) out.push(c);
    else out[out.length - 1] += (out[out.length - 1] && " ") + c;
  }
  return out;
}

// One worker and one audio context for every panel. The context starts
// suspended until the page is clicked or typed in, as browsers require.
let worker: Worker | undefined;
let asked = 0;
const waiting = new Map<number, (r: Synth) => void>();
// Whether the bridge says sentences; until one it can't, it's asked.
let bridged = true;
// Whether a sentence the bridge can't say is made in the page. The phone's
// isn't (src/phone): it's said only as subtitles, and the bridge asked again.
let inPage = true;
export const noVoiceInPage = () => (inPage = false);
let context: AudioContext | undefined;

function audio() {
  if (!context) {
    context = new AudioContext();
    const wake = () => context?.resume();
    for (const e of ["pointerdown", "keydown"]) addEventListener(e, wake, { capture: true });
  }
  return context;
}

async function synth(text: string, voice: string, speed: number, mood: Mood | undefined, bridge?: Bridge): Promise<Synth> {
  if (bridge && bridged) {
    try {
      const res = await bridge("speech", { method: "POST", body: JSON.stringify({ text, voice, speed, mood }), headers: { "content-type": "application/json" } });
      if (res.ok) {
        const phonemes = res.headers.get("x-phonemes");
        const frames = res.headers.get("x-frames");
        // The phone's are 16-bit, from the Worker.
        const body = await res.arrayBuffer();
        return {
          samples: res.headers.get("x-format") === "s16" ? Float32Array.from(new Int16Array(body), (v) => v / 0x7fff) : new Float32Array(body),
          rate: Number(res.headers.get("x-sample-rate")),
          ...(phonemes && frames && { phonemes: decodeURIComponent(phonemes), frames: frames.split(",").map(Number) }),
        };
      }
      console.warn("speech:", res.status, (await res.text()).trim());
    } catch (err) {
      console.warn("speech:", err);
    }
    if (!inPage) return { error: "the bridge didn't say it" };
    bridged = false;
  }
  if (!inPage) return { error: "no voice" };
  if (!worker) {
    worker = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const id = ++asked;
  worker.postMessage({ id, text, voice, speed, page: location.href });
  return new Promise((ok) => waiting.set(id, ok));
}

// An audio file's samples, at a rate.
const decode = (path: string, rate: number): Promise<Float32Array> =>
  fetch(new URL(path, document.baseURI))
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`no ${path}`))))
    .then((b) => new OfflineAudioContext(1, 1, rate).decodeAudioData(b))
    .then((b) => b.getChannelData(0));

// A take of a recording, at Kokoro's rate.
const takes = new Map<string, Promise<Float32Array>>();
function recording(name: string, rate: number): Promise<Float32Array> {
  const path = `voices/clips/${name}-${1 + Math.floor(Math.random() * TAKES)}.wav`;
  let r = takes.get(path);
  if (!r) {
    r = decode(path, rate);
    r.catch(() => takes.delete(path));
    takes.set(path, r);
  }
  return r;
}

// What a sentence of a line is made from: what's asked of the voice, or a
// recording if it's one.
export type Ask = { text: string; voice: string; speed: number; mood?: Mood; recorded?: string };
function ask(s: string, voice: string, mood?: Mood): Ask {
  const p = PITCHED[voice];
  return {
    text: respell(s),
    voice: p?.voice ?? voice,
    speed: (p?.speed ?? 1) * ((mood && MOODS[mood].speed) ?? 1),
    mood,
    recorded: voice === "anime" ? RECORDED.find(([re]) => re.test(s))?.[1] : undefined,
  };
}
const split = (text: string) => text.split(/(?<=[.!?…])\s+/).filter(Boolean);

// What's asked of the voice to say a line, but its recordings.
export const asks = (text: string, voice: string, mood?: Mood): Ask[] =>
  sentences(text)
    .flatMap(split)
    .map((s) => ask(s, voice, mood))
    .filter((a) => !a.recorded);
export const askKey = (a: Ask) => [a.voice, a.speed, a.mood ?? "", a.text].join("\n");

// What's been said ahead of time, by askKey: its file in voices/said, at
// its rate, and its phonemes if it has them.
// (ref is what bun run lines knows the recording it was cloned from by.)
export type SaidAhead = { file: string; rate: number; phonemes?: string; frames?: number[]; ref?: string };
let saidAhead: Promise<Record<string, SaidAhead>> | undefined;

// A sentence: said ahead of time if it was, else made now, unless only
// what was said ahead will do.
async function made(a: Ask, bridge: Bridge | undefined, only: boolean): Promise<Synth> {
  saidAhead ??= fetch(new URL("voices/said/index.json", document.baseURI))
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}));
  const s = (await saidAhead)[askKey(a)];
  if (s) {
    try {
      const samples = await decode(`voices/said/${s.file}`, s.rate);
      return { samples, rate: s.rate, ...(s.phonemes && s.frames && { phonemes: s.phonemes, frames: s.frames }) };
    } catch (err) {
      console.warn("speech:", err);
    }
  }
  if (only) return { error: "not said ahead" };
  return synth(a.text, a.voice, a.speed, a.mood, bridge);
}

// Samples made by times longer, their pitch kept (WSOLA): windows half
// overlapping, each taken from about where it falls, nudged to where it best
// goes on from the one before.
function stretch(x: Float32Array, by: number, rate: number): Float32Array {
  const n = Math.round(rate * 0.015) * 2;
  const hop = n / 2;
  const near = Math.round(rate * 0.006);
  const win = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const out = new Float32Array(Math.round(x.length * by));
  let prev = 0;
  for (let o = 0; o < out.length; o += hop) {
    let at = Math.min(Math.round(o / by), Math.max(0, x.length - n));
    if (o > 0) {
      const next = prev + hop;
      let top = -Infinity;
      for (let p = Math.max(0, at - near); p <= Math.min(x.length - n, at + near); p++) {
        let c = 0;
        for (let i = 0; i < hop && next + i < x.length; i += 2) c += x[next + i] * x[p + i];
        if (c > top) [top, at] = [c, p];
      }
    }
    for (let i = 0; i < n && o + i < out.length && at + i < x.length; i++) out[o + i] += x[at + i] * win[i];
    prev = at;
  }
  return out;
}

// A line's audio; with only, from what was said ahead of time, or none.
async function clip(text: string, voice: string, effect: Effect | undefined, mood: Mood | undefined, bridge: Bridge | undefined, failed: (why: string) => void, only = false): Promise<Clip | null> {
  const p = PITCHED[voice];
  // Pitched up by the effect too, each sentence made as much longer first.
  const by = effect === "ring" ? RING.pitch : 1;
  const m = mood && MOODS[mood];
  // Its sentences, each made, then a pause after each, a little more or less
  // each time.
  const parts = split(text);
  const said = await Promise.all(
    parts.map(async (s): Promise<Synth> => {
      const a = ask(s, voice, mood);
      if (a.recorded) return recording(a.recorded, 24000).then((samples) => ({ samples, rate: 24000 }), () => made(a, bridge, only));
      return made(a, bridge, only);
    }),
  );
  const bad = said.find((r) => !r.samples || !r.rate);
  if (bad) {
    if (!only) failed(bad.error ?? "no audio");
    return null;
  }
  const at = said[0].rate!;
  if (by !== 1) for (const r of said) r.samples = stretch(r.samples!, by, at);
  const gaps = parts.map((s) => Math.round(pause(s) * (m?.pause ?? 1) * (0.75 + Math.random() * 0.5) * at));
  const samples = new Float32Array(said.reduce((n, r, i) => n + r.samples!.length + gaps[i], 0));
  // Pitched by playing its samples faster.
  const rate = at * (p?.pitch ?? 1) * by;
  const marks: Mark[] = [];
  const spans: Span[] = [];
  let o = 0;
  let first = 0;
  said.forEach((r, i) => {
    samples.set(r.samples!, o);
    first = text.indexOf(parts[i], first);
    const last = first + parts[i].length;
    // Where it isn't silent; Kokoro holds a sentence's last sound well into
    // the quiet.
    const quiet = 0.02 * r.samples!.reduce((a, x) => Math.max(a, Math.abs(x)), 0);
    const from = o + Math.max(0, r.samples!.findIndex((x) => Math.abs(x) > quiet));
    const to = o + r.samples!.findLastIndex((x) => Math.abs(x) > quiet) + 1;
    // Each phoneme's shape from when Kokoro says it; or, for a recording,
    // each letter's, the letters taken to go evenly through it.
    const times: number[] = [];
    if (r.phonemes && r.frames) {
      let t = o;
      [...r.phonemes].forEach((c, j) => {
        const [shape, open] = sound(c);
        if (open >= 0) marks.push({ t: t / rate, shape, open });
        if (!SILENT.includes(c) && c !== " " && t < to) times.push(t);
        t += r.frames![j] * FRAME * by;
      });
    } else {
      for (let c = first; c < last; c++) marks.push({ t: (from + ((c - first) / (last - first)) * (to - from)) / rate, ...letter(text[c]) });
      marks.push({ t: to / rate, shape: null, open: 0 });
      times.push(from);
    }
    times.push(Math.max(to, times[times.length - 1] ?? 0));
    spans.push({ times: times.map((t) => t / rate), first, last });
    o += r.samples!.length + gaps[i];
    first = last;
  });
  const ctx = audio();
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  // Each slice's loudness (RMS), against the loudest slices'.
  const step = Math.round(rate / LOUD_HZ);
  const loud = new Float32Array(Math.ceil(samples.length / step));
  for (let i = 0; i < loud.length; i++) {
    let sum = 0;
    const end = Math.min((i + 1) * step, samples.length);
    for (let j = i * step; j < end; j++) sum += samples[j] * samples[j];
    loud[i] = Math.sqrt(sum / Math.max(1, end - i * step));
  }
  const top = [...loud].sort((a, b) => b - a)[Math.floor(loud.length * 0.1)] || 1;
  for (let i = 0; i < loud.length; i++) loud[i] = Math.min(1, loud[i] / top);
  return { buffer, loud, marks, spans };
}

// A letter's shape, and how far it opens, for a line said without phonemes.
function letter(c = " "): { shape: Viseme | null; open: number } {
  c = c.toLowerCase();
  if ("a".includes(c)) return { shape: "aa", open: 1 };
  if ("iy".includes(c)) return { shape: "ih", open: 0.8 };
  if ("uw".includes(c)) return { shape: "ou", open: 0.8 };
  if ("e".includes(c)) return { shape: "ee", open: 0.7 };
  if ("o".includes(c)) return { shape: "oh", open: 0.9 };
  if ("mbp ,.;:!?\n".includes(c)) return { shape: null, open: 0 };
  return { shape: "aa", open: 0.5 };
}

// Kokoro's pad and punctuation, which it says as silence.
const SILENT = "$;:,.!?—…\"()“”";

// A phoneme's shape (Kokoro's, from espeak) and how far it opens; the lips
// closed for m, b and p, and the shape before held through stress and
// length marks and between words (open -1).
const SOUNDS: [string, Viseme | null, number][] = [
  ["aɑɐæʌ", "aa", 1],
  ["ɔɒo", "oh", 0.9],
  ["uʊwɥ", "ou", 0.8],
  ["iɪjᵻy", "ih", 0.8],
  ["eɛɜœø", "ee", 0.7],
  ["əɚᵊ", "aa", 0.5],
  ["ɹɻr", "ou", 0.5],
  ["mbpβ", null, 0],
  ["fvθðszʃʒʧʤtdnlɾʔ", "ih", 0.4],
  ["ˈˌːʰʲ ", null, -1],
  [SILENT, null, 0],
];
function sound(c: string): [Viseme | null, number] {
  const s = SOUNDS.find(([cs]) => cs.includes(c));
  return s ? [s[1], s[2]] : ["aa", 0.4];
}

export class Voice {
  private queue: Line[] = [];
  private line?: Line;
  private playing?: Clip;
  // When the line started, in the audio context's time (seconds), and how
  // long it is; no start while its audio is still being made.
  private start?: number;
  private length = 0;
  private source?: AudioBufferSourceNode;
  private gain?: GainNode;
  // The effect's nodes between the source and gain, the hum first.
  private between: AudioNode[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private _muted = false;
  // Lines made ready (warm), by voice, effect, mood and text.
  private warmed = new Map<string, Promise<Clip | null>>();
  voice = VOICES[0];
  effect?: Effect;
  error = "";
  onChange?: () => void;

  constructor(private bridge?: Bridge) {}

  get speaking() {
    return !!this.line;
  }
  get text() {
    return this.line?.text ?? "";
  }
  // How the line being said is meant, if the session said.
  get mood() {
    return this.line?.mood;
  }
  get muted() {
    return this._muted;
  }
  set muted(on: boolean) {
    this._muted = on;
    if (this.gain) this.gain.gain.value = this.level();
  }
  private level() {
    return this._muted ? 0 : this.effect === "ring" ? RING.gain : 1;
  }

  // The newest item's sentences after what's left; anything older than the
  // item before it goes, so it keeps up with Claude.
  say(text: string, from: string, mood?: Mood) {
    const items = [...new Set(this.queue.map((l) => l.from))];
    if (items.length > 1) this.queue = this.queue.filter((l) => l.from === items[items.length - 1]);
    this.queue.push(
      ...sentences(text).map((t) => {
        const k = [this.voice, this.effect, mood, t].join("\n");
        const ready = this.warmed.get(k);
        this.warmed.delete(k);
        return { text: t, from, mood, clip: ready?.then((c) => c ?? clip(t, this.voice, this.effect, mood, this.bridge, (why) => (this.error = why))) };
      }),
    );
    this.ahead();
    if (!this.line) this.next();
  }

  // A line that was said ahead of time made ready, so that when it's said
  // it's heard at once.
  warm(text: string, mood?: Mood) {
    for (const t of sentences(text)) {
      const k = [this.voice, this.effect, mood, t].join("\n");
      if (!this.warmed.has(k)) this.warmed.set(k, clip(t, this.voice, this.effect, mood, undefined, () => {}, true));
    }
  }

  stop() {
    this.queue = [];
    this.end();
  }

  private now() {
    return this.playing ? audio().currentTime : performance.now() / 1000;
  }

  // Where it is in the line, in characters.
  at() {
    if (!this.line || this.start === undefined) return 0;
    const t = this.now() - this.start;
    if (!this.playing) return Math.min(1, Math.max(0, t / this.length)) * this.line.text.length;
    // Through each sentence a sound at a time while it's said, and still in
    // its pause.
    for (const { times, first, last } of this.playing.spans) {
      if (t < times[0]) return first;
      if (t >= times[times.length - 1]) continue;
      let k = 0;
      while (times[k + 1] <= t) k++;
      return first + ((k + (t - times[k]) / (times[k + 1] - times[k])) / (times.length - 1)) * (last - first);
    }
    return this.line.text.length;
  }

  // The mouth's shape now, and how open.
  mouth(): [Viseme | null, number] {
    if (!this.line || this.start === undefined) return [null, 0];
    if (!this.playing) {
      // No audio: each character opens and closes a little, like syllables.
      const i = this.at();
      const { shape, open } = letter(this.line.text[Math.floor(i)]);
      return [shape, open * (0.65 + 0.35 * Math.abs(Math.sin(i * 1.7)))];
    }
    const t = this.now() - this.start;
    const loud = this.playing.loud[Math.floor(t * LOUD_HZ)] ?? 0;
    if (loud < 0.08) return [null, 0];
    // The shape a little ahead of the sound, as the face eases into it.
    const marks = this.playing.marks;
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].t <= t + LEAD) lo = mid + 1;
      else hi = mid;
    }
    const mark = marks[lo - 1];
    if (!mark?.shape) return [null, 0];
    return [mark.shape, Math.min(1, loud * 1.2) * mark.open];
  }

  // The next few lines' audio, being made.
  private ahead() {
    if (this._muted) return;
    for (const l of this.queue.slice(0, AHEAD)) {
      l.clip ??= clip(l.text, this.voice, this.effect, l.mood, this.bridge, (why) => {
        this.error = why;
        this.onChange?.();
      });
    }
  }

  private async next() {
    const line = (this.line = this.queue.shift());
    this.start = this.playing = undefined;
    this.onChange?.();
    if (!line) return;
    if (!this._muted) line.clip ??= clip(line.text, this.voice, this.effect, line.mood, this.bridge, (why) => (this.error = why));
    this.ahead();
    const c = line.clip ? await line.clip : null;
    if (this.line !== line) return;
    if (c) {
      this.error = "";
      const ctx = audio();
      this.gain = ctx.createGain();
      this.gain.gain.value = this.level();
      this.gain.connect(ctx.destination);
      this.source = ctx.createBufferSource();
      this.source.buffer = c.buffer;
      if (this.effect === "ring") {
        // Ring modulated: through a gain the hum swings from 1 to -1, and
        // some of it dry.
        const hum = ctx.createOscillator();
        hum.frequency.value = RING.hz;
        const ring = ctx.createGain();
        ring.gain.value = 0;
        hum.connect(ring.gain);
        const dry = ctx.createGain();
        dry.gain.value = RING.dry;
        for (const g of [ring, dry]) {
          this.source.connect(g);
          g.connect(this.gain);
        }
        hum.start();
        this.between = [hum, ring, dry];
      } else this.source.connect(this.gain);
      this.source.onended = () => this.line === line && this.end();
      this.playing = c;
      this.length = c.buffer.duration;
      this.start = ctx.currentTime;
      this.source.start();
    } else {
      // Said in silence, in about the time it would take.
      this.length = line.text.length / CPS + 0.25;
      this.start = this.now();
      this.timer = setTimeout(() => this.line === line && this.end(), this.length * 1000);
    }
    this.onChange?.();
  }

  private end() {
    clearTimeout(this.timer);
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {}
      this.source.disconnect();
      (this.between[0] as OscillatorNode | undefined)?.stop();
      for (const n of this.between) n.disconnect();
      this.gain?.disconnect();
      this.source = this.gain = undefined;
      this.between = [];
    }
    this.line = undefined;
    this.next();
  }
}
