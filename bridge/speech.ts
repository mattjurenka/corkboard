// /speech: Kokoro (kokoro-js, on onnxruntime-node) saying a sentence for
// the avatar panel, on the CPU's physical cores, about 4 times as fast as
// it's said. With CORKBOARD_SPEECH_MODEL (the speech-model package: the fp16
// model as bridge/kokoro-gpu.py patches it) it's on the GPU instead, through
// ONNX Runtime's WebGPU EP; on an integrated GPU that's no faster, and the
// page's drawing stalls while it runs, so it isn't the default. If that
// fails, the CPU. Loaded the first time it's asked for (the CPU's model,
// 325 MB, is downloaded once into ~/.cache/corkboard/models, not into
// node_modules, which in the Nix package can't be written), and one
// sentence is made at a time. With its audio, when each of its phonemes is
// said (bridge/kokoro-timing.ts).
//
// Voices that have a recording to be cloned from (<voice>.wav, and
// <voice>-<mood>.wav for a mood), which every persona's has, are said by
// Chatterbox Nano instead, which can sound like it means it, when
// CORKBOARD_CHATTERBOX is a Python that has it (or there's a virtualenv with
// it at ~/.local/share/corkboard/chatterbox): bridge/chatterbox-speech.py,
// started the first time and kept, and waited for while it starts (if it
// won't start, Kokoro until the bridge does again). Its sentences come with
// no phonemes, so the mouth follows the letters. If it can't, Kokoro.

import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { timed, timing, withDurations } from "./kokoro-timing";
import { ownVoices } from "./kokoro-voices";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

type Tts = { generate(text: string, opts: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let tts: Promise<Tts> | undefined;
let last: Promise<unknown> = Promise.resolve();

type Ids = { data: BigInt64Array; dims: number[] };
type Floats = { data: Float32Array; dims: number[] };

// Where our voices are: the page's, as they are here or as the Nix package
// has them, built.
const voicesAt = (name: string) => {
  const web = join(import.meta.dir, "..", "web");
  return [join(web, "public", "voices", name), join(web, "dist", "voices", name)];
};

async function voiceFile(name: string): Promise<ArrayBuffer> {
  const [here, built] = voicesAt(`${name}.bin`);
  const file = await readFile(here).catch(() => readFile(built));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

// The recording a voice is cloned from, for a mood if it has one.
export async function reference(voice: string, mood?: string): Promise<string | undefined> {
  for (const name of [...(mood ? [`${voice}-${mood}.wav`] : []), `${voice}.wav`]) {
    for (const file of voicesAt(name)) if (await stat(file).catch(() => null)) return file;
  }
}

type Said = { audio: Float32Array; sampling_rate: number };
type Cloner = (text: string, ref: string) => Promise<Said>;
// The Python that has it, if any.
const chatterbox = (async () => {
  if (process.env.CORKBOARD_CHATTERBOX) return process.env.CORKBOARD_CHATTERBOX;
  const venv = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "corkboard", "chatterbox", "bin", "python");
  if (await stat(venv).catch(() => null)) return venv;
})();

// Being started, and once it's ready.
let cloning: Promise<unknown> | undefined;
let cloned: Cloner | undefined;

// bridge/chatterbox-speech.py, ready.
async function clone(python: string): Promise<Cloner> {
  const proc = Bun.spawn([python, join(import.meta.dir, "chatterbox-speech.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, CHATTERBOX_THREADS: process.env.CHATTERBOX_THREADS ?? String(Math.max(1, availableParallelism() >> 1)) },
  });
  const reader = proc.stdout.getReader();
  let buf = new Uint8Array(0);
  const more = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chatterbox exited (${await proc.exited})`);
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  };
  const take = (n: number) => {
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };
  const head = async () => {
    let nl;
    while ((nl = buf.indexOf(10)) < 0) await more();
    return JSON.parse(new TextDecoder().decode(take(nl + 1))) as { ready?: true; rate?: number; samples?: number; error?: string };
  };
  if (!(await head()).ready) throw new Error("chatterbox didn't start");
  const say: Cloner = async (text, ref) => {
    proc.stdin.write(JSON.stringify({ text, ref }) + "\n");
    proc.stdin.flush();
    // Anything it says that isn't an answer, and it's out of step: started again.
    const h = await head().catch((err) => {
      proc.kill();
      throw err;
    });
    if (h.error) throw new Error(h.error);
    while (buf.length < h.samples! * 4) await more();
    return { audio: new Float32Array(take(h.samples! * 4).buffer), sampling_rate: h.rate! };
  };
  // Started again if it stops after it was ready.
  proc.exited.then(() => cloned === say && (cloned = cloning = undefined));
  return say;
}

// The CPU's model, downloaded the first time.
async function cpuModel(cache: string): Promise<string> {
  const file = join(cache, MODEL, "onnx", "model.onnx");
  if (await stat(file).catch(() => null)) return file;
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/main/onnx/model.onnx`);
  if (!res.ok) throw new Error(`no speech model (${res.status})`);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(`${file}.part`, res);
  await rename(`${file}.part`, file);
  return file;
}

async function load(): Promise<Tts> {
  const [{ env, AutoTokenizer, Tensor }, { KokoroTTS }, ort] = await Promise.all([import("@huggingface/transformers"), import("kokoro-js"), import("onnxruntime-node")]);
  env.cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "corkboard", "models");
  const tokenizer = AutoTokenizer.from_pretrained(MODEL);
  const session = async (file: string, options: Parameters<typeof ort.InferenceSession.create>[1]) => {
    const s = await ort.InferenceSession.create(withDurations(await readFile(file)), options);
    return async ({ input_ids, style, speed }: { input_ids: Ids; style: Floats; speed: Floats }) =>
      s.run({
        input_ids: new ort.Tensor("int64", input_ids.data, input_ids.dims),
        style: new ort.Tensor("float32", style.data, style.dims),
        speed: new ort.Tensor("float32", speed.data, speed.dims),
      });
  };
  let model;
  const gpu = process.env.CORKBOARD_SPEECH_MODEL;
  if (gpu) {
    model = await session(gpu, { executionProviders: ["webgpu"] }).catch((err) => {
      console.error(`speech: no GPU (${err instanceof Error ? err.message : err}), so the CPU`);
    });
  }
  // Past the physical cores it's no faster, only busier.
  model ??= await session(await cpuModel(env.cacheDir), { intraOpNumThreads: Math.max(1, availableParallelism() >> 1) });
  return timed(ownVoices(new KokoroTTS(model as never, await tokenizer), Tensor, voiceFile)) as Tts;
}

export async function speech(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  // Not a form's content type, so a page elsewhere needs a preflight.
  if (req.headers.get("content-type") !== "application/json") return new Response("json", { status: 415 });
  const { text, voice, speed = 1, mood } = (await req.json()) as { text?: unknown; voice?: unknown; speed?: unknown; mood?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > 1000) return new Response("text", { status: 400 });
  if (typeof voice !== "string" || !/^[a-z]{2}_[a-z]+$/.test(voice)) return new Response("voice", { status: 400 });
  if (typeof speed !== "number" || !(speed >= 0.5 && speed <= 2)) return new Response("speed", { status: 400 });
  if (mood !== undefined && (typeof mood !== "string" || !/^[a-z]+$/.test(mood))) return new Response("mood", { status: 400 });
  const python = await chatterbox;
  const made = last.then(async (): Promise<Said> => {
    const ref = python && (await reference(voice, mood));
    // Starting takes from 15 s to more than a minute.
    if (ref) await (cloning ??= clone(python).then((c) => (cloned = c), (err) => console.error(`speech: no chatterbox (${err instanceof Error ? err.message : err}), so Kokoro`)));
    if (ref && cloned) {
      try {
        return await cloned(text, ref);
      } catch (err) {
        console.error(`speech: chatterbox (${err instanceof Error ? err.message : err}), so Kokoro`);
      }
    }
    tts ??= load();
    tts.catch(() => (tts = undefined));
    return (await tts).generate(text, { voice, speed });
  });
  last = made.catch(() => {});
  try {
    const { audio, sampling_rate } = await made;
    const headers: Record<string, string> = { "content-type": "application/octet-stream", "x-sample-rate": String(sampling_rate) };
    const t = timing(audio);
    if (t) {
      headers["x-phonemes"] = encodeURIComponent(t.phonemes);
      headers["x-frames"] = t.frames.join(",");
    }
    return new Response(audio, { headers });
  } catch (err) {
    return new Response(`speech: ${err instanceof Error ? err.message : err}`, { status: 503 });
  }
}
