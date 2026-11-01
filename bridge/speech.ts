// /speech: Kokoro (kokoro-js, on onnxruntime-node) saying a sentence for
// the avatar panel. With CORKBOARD_SPEECH_MODEL (the Nix package sets it to
// the fp16 model as bridge/kokoro-gpu.py patches it) it's on the GPU, through
// ONNX Runtime's WebGPU EP, about 3.5 times as fast as it's said and leaving
// the CPU alone; otherwise, or if that fails, on the CPU's physical cores,
// about 4 times. Loaded the first time it's asked for (the CPU's model,
// 325 MB, is downloaded once into ~/.cache/corkboard/models, not into
// node_modules, which in the Nix package can't be written), and one
// sentence is made at a time.

import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

type Tts = { generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let tts: Promise<Tts> | undefined;
let last: Promise<unknown> = Promise.resolve();

type Ids = { data: BigInt64Array; dims: number[] };
type Floats = { data: Float32Array; dims: number[] };

async function load(): Promise<Tts> {
  const [{ env, AutoTokenizer, StyleTextToSpeech2Model }, { KokoroTTS }] = await Promise.all([import("@huggingface/transformers"), import("kokoro-js")]);
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
      return new KokoroTTS(model as never, await tokenizer) as Tts;
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
  return new KokoroTTS(await model, await tokenizer) as Tts;
}

export async function speech(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  // Not a form's content type, so a page elsewhere needs a preflight.
  if (req.headers.get("content-type") !== "application/json") return new Response("json", { status: 415 });
  const { text, voice } = (await req.json()) as { text?: unknown; voice?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > 1000) return new Response("text", { status: 400 });
  if (typeof voice !== "string" || !/^[a-z]{2}_[a-z]+$/.test(voice)) return new Response("voice", { status: 400 });
  tts ??= load();
  tts.catch(() => (tts = undefined));
  const made = last.then(async () => (await tts!).generate(text, { voice }));
  last = made.catch(() => {});
  try {
    const { audio, sampling_rate } = await made;
    return new Response(audio, { headers: { "content-type": "application/octet-stream", "x-sample-rate": String(sampling_rate) } });
  } catch (err) {
    return new Response(`speech: ${err instanceof Error ? err.message : err}`, { status: 503 });
  }
}
