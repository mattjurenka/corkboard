// The models a meeting is heard with (listen.ts), on onnxruntime-node as
// speech.ts has Kokoro: Silero VAD for where there's speech, NVIDIA's
// Parakeet (sherpa-onnx) for what's said, and WeSpeaker (transformers.js)
// for whose voice it is. Each downloads the first time into the cache's
// models, as Kokoro's does.
//
// Parakeet TDT 0.6B v2, int8, is about 25 times faster than the audio on a
// laptop's CPU, three times Whisper small.en, and doesn't make up words in
// a silence.

import { availableParallelism } from "node:os";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { OggOpusDecoder } from "ogg-opus-decoder";
import { CACHE_DIR } from "./dirs";
import { sidecar } from "./speech";

const PARAKEET = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const PARAKEET_REV = "1ab9323565ddb038682214b292f588070a538ce2";
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

// A model's file, from Hugging Face the first time.
async function model(repo: string, rev: string, name: string): Promise<string> {
  const file = join(MODELS, repo, name);
  if (!(await Bun.file(file).exists())) {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/${rev}/${name}`);
    if (!res.ok) throw new Error(`downloading ${repo}: HTTP ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    await Bun.write(file + ".part", res);
    renameSync(file + ".part", file);
  }
  return file;
}

const parakeet = once(async () => {
  const sherpa = await sidecar<any>("sherpa-onnx-node");
  const [encoder, decoder, joiner, tokens] = await Promise.all(
    ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].map((f) => model(PARAKEET, PARAKEET_REV, f)),
  );
  return sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: threads.intraOpNumThreads,
      provider: "cpu",
      modelType: "nemo_transducer",
    },
  });
});

// What's said in audio, an utterance: "" for nothing. Decoded off the
// thread, so the tracks' pipes keep being read meanwhile.
export async function transcribe(audio: Float32Array): Promise<string> {
  const rec = await parakeet();
  const s = rec.createStream();
  s.acceptWaveform({ sampleRate: RATE, samples: audio });
  await rec.decodeAsync(s);
  return rec.getResult(s).text.trim();
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
  const file = await model(SILERO, "main", "onnx/model.onnx");
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
