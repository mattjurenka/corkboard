// What the avatar says: Claude's markdown made into sentences, each said by
// Kokoro (the bridge's /speech, or else kokoro.worker.ts in the page) a
// sentence ahead of the one playing, and where
// in it the voice is, which the mouth and the subtitles follow. How open the
// mouth is comes from how loud the audio is; its shape from the letter the
// voice is on, taken to go through the sentence evenly. Muted, or with no
// audio, a sentence is only timed, as if said.

export type Viseme = "aa" | "ih" | "ou" | "ee" | "oh";

// Kokoro's voices, the first the default; v in the panel goes to the next.
export const VOICES = ["af_heart", "af_bella", "af_nicole", "af_sky", "bf_emma", "am_michael"];

type Synth = { samples?: Float32Array; rate?: number; error?: string };
export type Bridge = (path: string, init?: RequestInit) => Promise<Response>;
type Clip = { buffer: AudioBuffer; loud: Float32Array };
type Line = { text: string; from: string; clip?: Promise<Clip | null> };

// Characters a second, for a sentence said without audio.
const CPS = 14;
// Sentences longer than this are said in parts.
const LONG = 200;
// The loudness is taken this many times a second.
const LOUD_HZ = 60;
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
  for (const part of speakable(md).split(/(?<=[.!?:])\s+|\n+/)) {
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


// One worker and one audio context for every panel. The context starts
// suspended until the page is clicked or typed in, as browsers require.
let worker: Worker | undefined;
let asked = 0;
const waiting = new Map<number, (r: Synth) => void>();
// Whether the bridge says sentences; until one it can't, it's asked.
let bridged = true;
let context: AudioContext | undefined;

function audio() {
  if (!context) {
    context = new AudioContext();
    const wake = () => context?.resume();
    for (const e of ["pointerdown", "keydown"]) addEventListener(e, wake, { capture: true });
  }
  return context;
}

async function synth(text: string, voice: string, bridge?: Bridge): Promise<Synth> {
  if (bridge && bridged) {
    try {
      const res = await bridge("speech", { method: "POST", body: JSON.stringify({ text, voice }), headers: { "content-type": "application/json" } });
      if (res.ok) return { samples: new Float32Array(await res.arrayBuffer()), rate: Number(res.headers.get("x-sample-rate")) };
      console.warn("speech:", res.status, (await res.text()).trim());
    } catch (err) {
      console.warn("speech:", err);
    }
    bridged = false;
  }
  if (!worker) {
    worker = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const id = ++asked;
  worker.postMessage({ id, text, voice });
  return new Promise((ok) => waiting.set(id, ok));
}

async function clip(text: string, voice: string, bridge: Bridge | undefined, failed: (why: string) => void): Promise<Clip | null> {
  const r = await synth(text, voice, bridge);
  if (!r.samples || !r.rate) {
    failed(r.error ?? "no audio");
    return null;
  }
  const ctx = audio();
  const buffer = ctx.createBuffer(1, r.samples.length, r.rate);
  buffer.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
  // Each slice's loudness (RMS), against the loudest slices'.
  const step = Math.round(r.rate / LOUD_HZ);
  const loud = new Float32Array(Math.ceil(r.samples.length / step));
  for (let i = 0; i < loud.length; i++) {
    let sum = 0;
    const end = Math.min((i + 1) * step, r.samples.length);
    for (let j = i * step; j < end; j++) sum += r.samples[j] * r.samples[j];
    loud[i] = Math.sqrt(sum / Math.max(1, end - i * step));
  }
  const top = [...loud].sort((a, b) => b - a)[Math.floor(loud.length * 0.1)] || 1;
  for (let i = 0; i < loud.length; i++) loud[i] = Math.min(1, loud[i] / top);
  return { buffer, loud };
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
  private timer?: ReturnType<typeof setTimeout>;
  private _muted = false;
  voice = VOICES[0];
  error = "";
  onChange?: () => void;

  constructor(private bridge?: Bridge) {}

  get speaking() {
    return !!this.line;
  }
  get text() {
    return this.line?.text ?? "";
  }
  get muted() {
    return this._muted;
  }
  set muted(on: boolean) {
    this._muted = on;
    if (this.gain) this.gain.gain.value = on ? 0 : 1;
  }

  // The newest item's sentences after what's left; anything older than the
  // item before it goes, so it keeps up with Claude.
  say(text: string, from: string) {
    const items = [...new Set(this.queue.map((l) => l.from))];
    if (items.length > 1) this.queue = this.queue.filter((l) => l.from === items[items.length - 1]);
    this.queue.push(...sentences(text).map((t) => ({ text: t, from })));
    this.ahead();
    if (!this.line) this.next();
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
    const done = Math.max(0, (this.now() - this.start) / this.length);
    return Math.min(1, done) * this.line.text.length;
  }

  // The mouth's shape now, and how open.
  mouth(): [Viseme | null, number] {
    if (!this.line || this.start === undefined) return [null, 0];
    const i = this.at();
    let open: number;
    if (this.playing) {
      const loud = this.playing.loud[Math.floor((this.now() - this.start) * LOUD_HZ)] ?? 0;
      if (loud < 0.08) return [null, 0];
      open = Math.min(1, loud * 1.2);
    } else {
      // No audio: each character opens and closes a little, like syllables.
      open = 0.65 + 0.35 * Math.abs(Math.sin(i * 1.7));
    }
    const c = this.line.text[Math.floor(i)]?.toLowerCase() ?? " ";
    if ("a".includes(c)) return ["aa", open];
    if ("iy".includes(c)) return ["ih", open * 0.8];
    if ("uw".includes(c)) return ["ou", open * 0.8];
    if ("e".includes(c)) return ["ee", open * 0.7];
    if ("o".includes(c)) return ["oh", open * 0.9];
    if (!this.playing && "mbp ,.;:!?\n".includes(c)) return [null, 0];
    return ["aa", open * 0.5];
  }

  // The next few lines' audio, being made.
  private ahead() {
    if (this._muted) return;
    for (const l of this.queue.slice(0, AHEAD)) {
      l.clip ??= clip(l.text, this.voice, this.bridge, (why) => {
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
    if (!this._muted) line.clip ??= clip(line.text, this.voice, this.bridge, (why) => (this.error = why));
    this.ahead();
    const c = line.clip ? await line.clip : null;
    if (this.line !== line) return;
    if (c) {
      this.error = "";
      const ctx = audio();
      this.gain = ctx.createGain();
      this.gain.gain.value = this._muted ? 0 : 1;
      this.gain.connect(ctx.destination);
      this.source = ctx.createBufferSource();
      this.source.buffer = c.buffer;
      this.source.connect(this.gain);
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
      this.gain?.disconnect();
      this.source = this.gain = undefined;
    }
    this.line = undefined;
    this.next();
  }
}
