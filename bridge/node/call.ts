// A voice call with Pepper (.agent/plans/voice-call.md, step 2): the phone
// carries audio, the node hears and speaks. What the user says is cut into
// utterances where Silero hears speech, transcribed by Parakeet and posted
// to the chat as theirs, from "call", which fleetd passes to Pepper as
// "[call] …"; what Pepper says in the chat meanwhile is said back, a
// sentence at a time, with the avatar's voice. Talking over it stops it.
//
// While something Pepper would do waits for the user (confirm.ts), an
// utterance that's only a yes or a no decides the newest of them here,
// and Pepper is told what came of it; it never hears the yes itself. A
// session that starts asking during the call is told to Pepper too, from
// "away", so it says so unasked.
//
// ndjson both ways. In: { type: "audio", data } (base64 16-bit samples,
// 16 kHz mono), { type: "end" }. Out: { type: "heard", text },
// { type: "say", text, rate, audio } (base64 16-bit samples), { type:
// "stop" } (stop playing: the user talks over it), { type: "confirm", id,
// what }, { type: "decided", id, state }.

import { lines } from "../hub";
import { say as speak } from "../speech";
import { FRAME, RATE, Vad, transcribe } from "../transcribe";
import type { Confirms, Held } from "./confirm";
import type { Data } from "./data";
import type { Sessions } from "./mcp";

// What a call is heard and said with: transcribe.ts's and speech.ts's, or a test's.
export type CallModels = {
  vad: () => { next(frame: Float32Array): Promise<number> };
  transcribe: (audio: Float32Array) => Promise<string>;
  say: (text: string) => Promise<{ audio: Float32Array; rate: number }>;
};

export type CallOptions = {
  data: Data;
  confirms: Confirms;
  sessions?: Sessions;
  voice: string;
  speed: number;
  models?: CallModels;
};

const FRAME_MS = (FRAME / RATE) * 1000;
// Speech starts above ON and goes on until below OFF for HANG_MS: longer
// than a meeting's (listen.ts), as a pause in what's asked isn't its end.
const ON = 0.5;
const OFF = 0.35;
const HANG_MS = 800;
const PAD_MS = 200;
const MAX_MS = 30_000;
const MIN_MS = 300;
const frames = (ms: number) => Math.round(ms / FRAME_MS);

// A whole utterance that's only a yes, or only a no.
const YES = /^(yes|yeah|yep|yup|sure|okay|ok|confirm|confirmed|approve|approved|do it|go ahead|go for it)( please| do it| go ahead)*$/;
const NO = /^(no|nope|nah|cancel|cancel it|don't|don't do it|do not|stop|never mind)( thanks| thank you)*$/;
export function answer(text: string): boolean | undefined {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  return YES.test(t) ? true : NO.test(t) ? false : undefined;
}

// What's said aloud of a chat message: its markdown's words, a sentence each.
export function spoken(md: string): string[] {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]+/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*[-+]\s+/, "").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const pcm16 = (audio: Float32Array) => {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = Math.max(-1, Math.min(1, audio[i])) * 0x7fff;
  return Buffer.from(out.buffer).toString("base64");
};
const floats = (b64: string) => {
  const b = Buffer.from(b64, "base64");
  const s = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  return Float32Array.from(s, (x) => x / 0x8000);
};

const NEEDS = ["asking", "permission"];
const DECIDED = new Map<Held["state"], string>([
  ["done", "It's done."],
  ["refused", "It won't happen."],
  ["expired", "It had expired."],
  ["failed", "It failed"],
]);

export function call(input: ReadableStream<Uint8Array>, o: CallOptions, signal?: AbortSignal): Response {
  const models = o.models ?? { vad: () => new Vad(), transcribe, say: (text) => speak({ text, voice: o.voice, speed: o.speed }) };
  const enc = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let over = false;
  const send = (m: object) => {
    if (over) return;
    try {
      out.enqueue(enc.encode(JSON.stringify(m) + "\n"));
    } catch {
      end();
    }
  };
  const offs: (() => void)[] = [];
  const end = () => {
    if (over) return;
    over = true;
    for (const off of offs) off();
    try {
      out.close();
    } catch {}
  };

  // Heard: the stream of frames, cut into utterances, each taken in turn.
  const vad = models.vad();
  let rest = new Float32Array(0);
  let pre: Float32Array[] = [];
  let utt: Float32Array[] | null = null;
  let quiet = 0;
  let work = Promise.resolve();
  let feeding = Promise.resolve();

  const cut = (n: number) => {
    const u = utt!.slice(0, n);
    utt = null;
    pre = [];
    if (u.length * FRAME_MS < MIN_MS) return;
    const audio = new Float32Array(u.length * FRAME);
    u.forEach((f, i) => audio.set(f, i * FRAME));
    work = work.then(() => heard(audio)).catch((e) => console.error(`call: ${e instanceof Error ? e.message : e}`));
  };

  const frame = async (f: Float32Array) => {
    const p = await vad.next(f);
    if (!utt) {
      pre.push(f);
      if (pre.length > frames(PAD_MS)) pre.shift();
      if (p >= ON) {
        utt = pre;
        pre = [];
        quiet = 0;
        hush();
      }
      return;
    }
    utt.push(f);
    quiet = p < OFF ? quiet + 1 : 0;
    if (quiet >= frames(HANG_MS)) cut(utt.length - quiet + frames(PAD_MS));
    else if (utt.length * FRAME_MS >= MAX_MS) cut(utt.length);
  };

  const feed = async (samples: Float32Array) => {
    let all = samples;
    if (rest.length) {
      all = new Float32Array(rest.length + samples.length);
      all.set(rest);
      all.set(samples, rest.length);
    }
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) await frame(all.slice(i, i + FRAME));
    rest = all.slice(i);
  };

  async function heard(audio: Float32Array) {
    const text = await models.transcribe(audio);
    if (!text || over) return;
    send({ type: "heard", text });
    const waiting = o.confirms.waiting();
    const yes = waiting.length ? answer(text) : undefined;
    if (yes === undefined) return void (await o.data.post("call", text, true));
    const newest = waiting.reduce((a, h) => (h.at > a.at ? h : a));
    const h = await o.confirms.decide(newest.id, yes).catch((e: Error) => ({ ...newest, state: "failed", error: e.message }) as Held);
    await o.data.post("call", `${yes ? "Yes" : "No"} to "${h.what}". ${DECIDED.get(h.state) ?? ""}${h.error ? `: ${h.error}` : ""}`.trim(), true);
  }

  // Said: Pepper's sentences in turn, until the user talks over them.
  let queue: string[] = [];
  let saying = false;
  let gen = 0;
  // When what's been sent will have been played.
  let playing = 0;
  const hush = () => {
    if (!queue.length && !saying && Date.now() >= playing) return;
    gen++;
    queue = [];
    playing = 0;
    send({ type: "stop" });
  };
  const speakNext = async () => {
    if (saying) return;
    saying = true;
    try {
      for (let text; (text = queue.shift()) !== undefined && !over; ) {
        const g = gen;
        const { audio, rate } = await models.say(text).catch((e) => (console.error(`call: speech: ${e instanceof Error ? e.message : e}`), { audio: new Float32Array(), rate: 0 }));
        if (g !== gen || !audio.length) continue;
        send({ type: "say", text, rate, audio: pcm16(audio) });
        playing = Math.max(Date.now(), playing) + (audio.length / rate) * 1000;
      }
    } finally {
      saying = false;
    }
  };

  // Pepper's messages from now on.
  let last = o.data.chat(undefined, 1).at(-1)?.id ?? "";
  const read = () => {
    for (const m of o.data.chat(last, 500)) {
      last = m.id;
      if (!m.by_user) queue.push(...spoken(m.text));
    }
    if (queue.length) void speakNext();
  };
  offs.push(o.data.replicas.onChange((x) => x.kind === "day" && read()));

  // What waits for the user's yes, and what came of it.
  const told = (h: Held) => send(h.state === "waiting" ? { type: "confirm", id: h.id, what: h.what } : { type: "decided", id: h.id, state: h.state });
  for (const h of o.confirms.waiting()) told(h);
  offs.push(o.confirms.on(told));

  // A session that starts asking, for Pepper to say so.
  const states = new Map<string, string>();
  for (const b of o.sessions?.list() ?? []) for (const s of b.sessions as any[]) states.set(`${b.id} ${s.key}`, String(s.state ?? ""));
  if (o.sessions?.on)
    offs.push(
      o.sessions.on((b) => {
        if ("gone" in b) return;
        for (const s of b.sessions as any[]) {
          const k = `${b.id} ${s.key}`, state = String(s.state ?? "");
          const was = states.get(k);
          states.set(k, state);
          if (!s.key || !NEEDS.includes(state) || NEEDS.includes(was ?? "")) continue;
          const asks = state === "permission" ? "wants permission" : "is asking";
          void o.data.post("away", `${s.project || "A session"} on ${b.machine} ${asks}${s.detail ? `: ${s.detail}` : ""} (bridge ${b.id}, key ${s.key})`, true);
        }
      }),
    );

  const body = new ReadableStream<Uint8Array>({ start: (c) => void (out = c), cancel: () => end() });
  const a = new AbortController();
  signal?.addEventListener("abort", () => a.abort(), { once: true });
  offs.push(() => a.abort());
  void lines(
    input,
    (m) => {
      // The rest of what's heard is still said, then it's over.
      if (m?.type === "end") return a.abort();
      if (m?.type === "audio" && typeof m.data === "string") {
        const samples = floats(m.data);
        feeding = feeding.then(() => feed(samples)).catch((e) => console.error(`call: ${e instanceof Error ? e.message : e}`));
      }
    },
    a.signal,
  )
    .catch(() => {})
    // What was being said when the phone hung up is still heard.
    .then(() => feeding)
    .then(() => {
      if (utt) cut(utt.length);
      return work;
    })
    .finally(end);
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
