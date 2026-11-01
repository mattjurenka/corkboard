// Kokoro, the speech model, off the page's thread: given a sentence and a
// voice, its audio (24kHz mono). The model comes from Hugging Face the
// first time (about 90MB) and from the browser's cache after; on WebGPU
// where there is one, else wasm.

import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts: Promise<KokoroTTS> | undefined;

async function load() {
  const gpu = "gpu" in navigator && (await (navigator as any).gpu.requestAdapter().catch(() => null));
  return KokoroTTS.from_pretrained(MODEL, gpu ? { dtype: "fp32", device: "webgpu" } : { dtype: "q8", device: "wasm" });
}

self.onmessage = async (e: MessageEvent<{ id: number; text: string; voice: string }>) => {
  const { id, text, voice } = e.data;
  try {
    tts ??= load();
    const audio = await (await tts).generate(text, { voice: voice as any });
    const samples = audio.audio as Float32Array;
    self.postMessage({ id, samples, rate: audio.sampling_rate }, { transfer: [samples.buffer] });
  } catch (err) {
    // A model that didn't load is tried again next time.
    if (tts && !(await tts.then(() => true, () => false))) tts = undefined;
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
