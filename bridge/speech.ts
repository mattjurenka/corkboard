// /speech: Kokoro (kokoro-js, on onnxruntime-node) saying a sentence for
// the avatar panel, about twice as fast as it's said; in the page, on one
// thread, it's slower than that. Loaded the first time it's asked for (the
// model, 325 MB, is downloaded once into ~/.cache/corkboard/models, not
// into node_modules, which in the Nix package can't be written), and one
// sentence is made at a time.

import { homedir } from "node:os";
import { join } from "node:path";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

type Tts = { generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let tts: Promise<Tts> | undefined;
let last: Promise<unknown> = Promise.resolve();

function load(): Promise<Tts> {
  return Promise.all([import("@huggingface/transformers"), import("kokoro-js")]).then(([{ env }, { KokoroTTS }]) => {
    env.cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "corkboard", "models");
    return KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" }) as Promise<Tts>;
  });
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
