// /speech: Kokoro (kokoro-js, on onnxruntime-node) saying a sentence for
// the avatar panel, on the CPU's physical cores, about 4 times as fast as
// it's said. With CORKBOARD_SPEECH_MODEL (the speech-model package: the fp16
// model as bridge/kokoro-gpu.py patches it) it's on the GPU instead, through
// ONNX Runtime's WebGPU EP; on an integrated GPU that's no faster, and the
// page's drawing stalls while it runs, so it isn't the default. If that
// fails, the CPU. Loaded the first time it's asked for (the CPU's model,
// 325 MB, is downloaded once into ~/.cache/corkboard/models, not into
// node_modules, which in the Nix package can't be written), and one
// sentence is made at a time.

import { readFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { ownVoices } from "./kokoro-voices";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

type Tts = { generate(text: string, opts: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let tts: Promise<Tts> | undefined;
let last: Promise<unknown> = Promise.resolve();

type Ids = { data: BigInt64Array; dims: number[] };
type Floats = { data: Float32Array; dims: number[] };

// Our own voices' files: the page's, as they are here or as the Nix package
// has them, built.
async function voiceFile(name: string): Promise<ArrayBuffer> {
  const web = join(import.meta.dir, "..", "web");
  const file = await readFile(join(web, "public", "voices", `${name}.bin`)).catch(() => readFile(join(web, "dist", "voices", `${name}.bin`)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

async function load(): Promise<Tts> {
  const [{ env, AutoTokenizer, StyleTextToSpeech2Model, Tensor }, { KokoroTTS }] = await Promise.all([import("@huggingface/transformers"), import("kokoro-js")]);
  env.cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "corkboard", "models");
  const tokenizer = AutoTokenizer.from_pretrained(MODEL);
  const gpu = process.env.CORKBOARD_SPEECH_MODEL;
  if (gpu) {
    try {
      const ort = await import("onnxruntime-node");
      const session = await ort.InferenceSession.create(gpu, { executionProviders: ["webgpu"] });
      const model = async ({ input_ids, style, speed }: { input_ids: Ids; style: Floats; speed: Floats }) => {
        const out = await session.run({
          input_ids: new ort.Tensor("int64", input_ids.data, input_ids.dims),
          style: new ort.Tensor("float32", style.data, style.dims),
          speed: new ort.Tensor("float32", speed.data, speed.dims),
        });
        return { waveform: out.waveform };
      };
      return ownVoices(new KokoroTTS(model as never, await tokenizer), Tensor, voiceFile) as Tts;
    } catch (err) {
      console.error(`speech: no GPU (${err instanceof Error ? err.message : err}), so the CPU`);
    }
  }
  const model = StyleTextToSpeech2Model.from_pretrained(MODEL, {
    dtype: "fp32",
    device: "cpu",
    // Past the physical cores it's no faster, only busier.
    session_options: { intraOpNumThreads: Math.max(1, availableParallelism() >> 1) },
  });
  return ownVoices(new KokoroTTS(await model, await tokenizer), Tensor, voiceFile) as Tts;
}

export async function speech(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  // Not a form's content type, so a page elsewhere needs a preflight.
  if (req.headers.get("content-type") !== "application/json") return new Response("json", { status: 415 });
  const { text, voice, speed = 1 } = (await req.json()) as { text?: unknown; voice?: unknown; speed?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > 1000) return new Response("text", { status: 400 });
  if (typeof voice !== "string" || !/^[a-z]{2}_[a-z]+$/.test(voice)) return new Response("voice", { status: 400 });
  if (typeof speed !== "number" || !(speed >= 0.5 && speed <= 2)) return new Response("speed", { status: 400 });
  tts ??= load();
  tts.catch(() => (tts = undefined));
  const made = last.then(async () => (await tts!).generate(text, { voice, speed }));
  last = made.catch(() => {});
  try {
    const { audio, sampling_rate } = await made;
    return new Response(audio, { headers: { "content-type": "application/octet-stream", "x-sample-rate": String(sampling_rate) } });
  } catch (err) {
    return new Response(`speech: ${err instanceof Error ? err.message : err}`, { status: 503 });
  }
}
