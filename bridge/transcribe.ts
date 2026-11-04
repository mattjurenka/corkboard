// The models a meeting is heard with (listen.ts), on onnxruntime-node as
// speech.ts has Kokoro: Silero VAD for where there's speech, Whisper
// (transformers.js) for what's said, and WeSpeaker for whose voice it is.
// Each downloads the first time into the cache's models, as Kokoro's does.
//
// CORKBOARD_TRANSCRIBE_MODEL names another Whisper on Hugging Face's ONNX
// ones; small.en is about four times faster than the audio on a laptop's CPU.

import { availableParallelism } from "node:os";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { OggOpusDecoder } from "ogg-opus-decoder";
import { CACHE_DIR } from "./dirs";
import { sidecar } from "./speech";

const WHISPER = process.env.CORKBOARD_TRANSCRIBE_MODEL || "onnx-community/whisper-small.en";
const WESPEAKER = "onnx-community/wespeaker-voxceleb-resnet34-LM";
const SILERO = "onnx-community/silero-vad";
export const RATE = 16_000;
// Silero's window at 16 kHz.
export const FRAME = 512;
const MODELS = join(CACHE_DIR, "models");

type Transformers = typeof import("@huggingface/transformers");
type Ort = typeof import("onnxruntime-node");
const transformers = () =>
  sidecar<Transformers>("@huggingface/transformers").then((t) => {
    t.env.cacheDir = MODELS;
    return t;
  });

// Loaded once, and again after a failure.
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () =>
    (p ??= load().catch((err) => {
      p = undefined;
      throw err;
    }));
}

// Past the physical cores it's no faster, only busier, and a call is on.
const threads = { intraOpNumThreads: Math.max(1, availableParallelism() >> 1) };

type Asr = (audio: Float32Array, options?: object) => Promise<{ text: string }>;
const asr = once(async () => {
  const { pipeline } = await transformers();
  return (await pipeline("automatic-speech-recognition", WHISPER, { dtype: "q8", session_options: threads } as never)) as unknown as Asr;
});

// What's said in audio, an utterance: "" for nothing, or only a [noise].
export async function whisper(audio: Float32Array): Promise<string> {
  const { text } = await (await asr())(audio);
  const t = text.trim();
  return /^[[(].*[\])]$/.test(t) ? "" : t;
}

const speaker = once(async () => {
  const { AutoModel, AutoProcessor } = await transformers();
  const [model, processor] = await Promise.all([
    AutoModel.from_pretrained(WESPEAKER, { dtype: "fp32", session_options: threads } as never),
    AutoProcessor.from_pretrained(WESPEAKER),
  ]);
  return { model, processor };
});

// The voice in audio, as a unit vector: near another's (dot product) when
// it's the same person.
export async function voice(audio: Float32Array): Promise<Float32Array> {
  const { model, processor } = await speaker();
  const { last_hidden_state } = await model(await processor(audio));
  const v = Float32Array.from(last_hidden_state.data as Float32Array);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const silero = once(async () => {
  const ort = await sidecar<Ort>("onnxruntime-node");
  const file = join(MODELS, SILERO, "onnx/model.onnx");
  if (!(await Bun.file(file).exists())) {
    const res = await fetch(`https://huggingface.co/${SILERO}/resolve/main/onnx/model.onnx`);
    if (!res.ok) throw new Error(`downloading ${SILERO}: HTTP ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    await Bun.write(file + ".part", res);
    renameSync(file + ".part", file);
  }
  return { ort, session: await ort.InferenceSession.create(file, { intraOpNumThreads: 1 }) };
});

// A stream's voice activity: the chance each FRAME of it is speech. It
// keeps the stream's state, so one per stream, fed in order.
export class Vad {
  private state?: import("onnxruntime-node").Tensor;
  async next(frame: Float32Array): Promise<number> {
    const { ort, session } = await silero();
    this.state ??= new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const r = await session.run({
      input: new ort.Tensor("float32", frame, [1, FRAME]),
      state: this.state,
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []),
    });
    this.state = r.stateN;
    return (r.output.data as Float32Array)[0];
  }
}

// A chunk (record.ts) as 16 kHz samples.
export async function decode(file: string): Promise<Float32Array> {
  const decoder = new OggOpusDecoder({ sampleRate: RATE } as never);
  await decoder.ready;
  try {
    const { channelData } = await decoder.decodeFile(new Uint8Array(await Bun.file(file).arrayBuffer()));
    return channelData[0] ?? new Float32Array();
  } finally {
    decoder.free();
  }
}
