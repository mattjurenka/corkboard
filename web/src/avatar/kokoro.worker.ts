// Kokoro, the speech model, off the page's thread: given a sentence and a
// voice, its audio (24kHz mono) and when each of its phonemes is said
// (bridge/kokoro-timing.ts). The model comes from Hugging Face the
// first time (about 90MB) and from the browser's cache after, and is given
// the phonemes' durations as an output as it's read; on wasm, since
// ONNX Runtime's WebGPU gets some of Kokoro's ConvTransposes wrong (see
// bridge/kokoro-gpu.py). Our own voices come from the page's voices/.

import { env, Tensor } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { timed, timing, withDurations } from "../../../bridge/kokoro-timing";
import { ownVoices } from "../../../bridge/kokoro-voices";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

const isModel = (url: unknown) => /\/onnx\/model[^/]*\.onnx$/.test(String(url));
const withOutput = async (res: Response) => {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(withDurations(new Uint8Array(await res.arrayBuffer())), { status: res.status, headers });
};
const fetched = env.fetch;
env.fetch = async (url, init) => {
  const res = await fetched(url, init);
  return isModel(url) && res.status === 200 ? withOutput(res) : res;
};
const cache = caches.open(env.cacheKey);
env.customCache = {
  match: async (key: string) => {
    const res = await (await cache).match(key);
    return res && isModel(key) ? withOutput(res) : res;
  },
  put: async (key: string, res: Response) => (await cache).put(key, res),
};

let tts: Promise<KokoroTTS> | undefined;

async function load(page: string) {
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm" });
  return timed(
    ownVoices(tts, Tensor, async (name) => {
      const res = await fetch(new URL(`voices/${name}.bin`, page));
      if (!res.ok) throw new Error(`no voice ${name}`);
      return res.arrayBuffer();
    }),
  );
}

self.onmessage = async (e: MessageEvent<{ id: number; text: string; voice: string; speed?: number; page: string }>) => {
  const { id, text, voice, speed = 1, page } = e.data;
  try {
    tts ??= load(page);
    const audio = await (await tts).generate(text, { voice: voice as any, speed });
    const samples = audio.audio as Float32Array;
    self.postMessage({ id, samples, rate: audio.sampling_rate, ...timing(samples) }, { transfer: [samples.buffer] });
  } catch (err) {
    // A model that didn't load is tried again next time.
    if (tts && !(await tts.then(() => true, () => false))) tts = undefined;
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
