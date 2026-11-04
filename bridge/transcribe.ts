// A meeting's chunks (record.ts) as text: each Ogg Opus file decoded to
// 16 kHz samples (ogg-opus-decoder) and given to Whisper (transformers.js,
// on onnxruntime-node, as speech.ts has Kokoro). The model downloads the
// first time into the cache's models, as Kokoro's does.
//
// CORKBOARD_TRANSCRIBE_MODEL names another Whisper on Hugging Face's ONNX
// ones; small.en is about four times faster than the audio on a laptop's CPU.

import { availableParallelism } from "node:os";
import { join } from "node:path";
import { OggOpusDecoder } from "ogg-opus-decoder";
import { CACHE_DIR } from "./dirs";
import { sidecar } from "./speech";

const MODEL = process.env.CORKBOARD_TRANSCRIBE_MODEL || "onnx-community/whisper-small.en";
const RATE = 16_000;
// Quieter than this all through, a chunk is silence, which Whisper would
// otherwise hear as "Thank you."
const SILENT_RMS = 0.002;

// ms from the chunk's start.
export type Said = { start: number; stop: number; text: string };

type Asr = (audio: Float32Array, options: object) => Promise<{ text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>;
let asr: Promise<Asr> | undefined;

async function load(): Promise<Asr> {
  const { env, pipeline } = await sidecar<typeof import("@huggingface/transformers")>("@huggingface/transformers");
  env.cacheDir = join(CACHE_DIR, "models");
  return (await pipeline("automatic-speech-recognition", MODEL, {
    dtype: "q8",
    // Past the physical cores it's no faster, only busier, and a call is on.
    session_options: { intraOpNumThreads: Math.max(1, availableParallelism() >> 1) },
  } as never)) as unknown as Asr;
}

async function decode(file: string): Promise<Float32Array> {
  const decoder = new OggOpusDecoder({ sampleRate: RATE } as never);
  await decoder.ready;
  try {
    const { channelData } = await decoder.decodeFile(new Uint8Array(await Bun.file(file).arrayBuffer()));
    return channelData[0] ?? new Float32Array();
  } finally {
    decoder.free();
  }
}

const rms = (a: Float32Array) => {
  let sum = 0;
  for (const x of a) sum += x * x;
  return Math.sqrt(sum / (a.length || 1));
};

// What's said in file, in order.
export async function transcribe(file: string): Promise<Said[]> {
  const audio = await decode(file);
  if (rms(audio) < SILENT_RMS) return [];
  asr ??= load().catch((err) => {
    asr = undefined;
    throw err;
  });
  const { text, chunks } = await (await asr)(audio, { return_timestamps: true, chunk_length_s: 30 });
  const length = (audio.length / RATE) * 1000;
  const said = (chunks ?? [{ timestamp: [0, null], text }]).map(({ timestamp: [a, b], text }) => ({
    start: Math.round(a * 1000),
    stop: Math.round(b === null ? length : b * 1000),
    text: text.trim(),
  }));
  return said.filter((s) => s.text && !/^[[(].*[\])]$/.test(s.text));
}
