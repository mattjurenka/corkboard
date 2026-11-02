// When in Kokoro's audio each of its phonemes is said, so the avatar's
// mouth can follow the sounds rather than the letters. Kokoro decides how
// many frames (of 600 samples) each phoneme of a sentence lasts before it
// makes the audio, but onnx-community's model only gives back the audio; so
// the model is given that tensor as a second output, by adding its name to
// the graph's outputs in the model's protobuf, and what each sentence is
// made with is kept for its audio. Used by bridge/speech.ts and the page's
// web/src/avatar/kokoro.worker.ts.

// Each phoneme's frames (int64, one per token, the pads at either end too).
export const DURATIONS = "/encoder/Cast_output_0";
export const FRAME = 600;

// A sentence's phonemes, a character each with "$" the pad, and how many
// frames each lasts.
export type Timing = { phonemes: string; frames: number[] };

// The model, with DURATIONS among its outputs; as it is if it already is.
export function withDurations<B extends ArrayBufferLike>(model: Uint8Array<B>): Uint8Array<B | ArrayBuffer> {
  const name = new TextEncoder().encode(DURATIONS);
  let i = 0;
  const varint = () => {
    let r = 0;
    let m = 1;
    let c;
    do {
      c = model[i++];
      r += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    return r;
  };
  // ModelProto's graph is field 7; GraphProto's outputs are field 12, each
  // a ValueInfoProto whose name is field 1.
  while (i < model.length) {
    const at = i;
    const key = varint();
    if ((key & 7) === 0) {
      varint();
      continue;
    }
    if ((key & 7) !== 2) throw new Error("speech model: not a model");
    const length = varint();
    if (key >> 3 !== 7) {
      i += length;
      continue;
    }
    const start = i;
    const end = i + length;
    while (i < end) {
      const k = varint();
      if ((k & 7) === 0) {
        varint();
        continue;
      }
      if ((k & 7) === 5 || (k & 7) === 1) {
        i += (k & 7) === 5 ? 4 : 8;
        continue;
      }
      const n = varint();
      if (k >> 3 === 12 && model[i] === 0x0a && model[i + 1] === name.length && name.every((b, j) => model[i + 2 + j] === b)) return model;
      i += n;
    }
    const info = [0x0a, ...bytes(name.length), ...name];
    const output = [(12 << 3) | 2, ...bytes(info.length), ...info];
    const out = new Uint8Array(model.length + output.length + 10);
    let o = 0;
    for (const part of [model.subarray(0, at), [(7 << 3) | 2, ...bytes(length + output.length)], model.subarray(start, end), output, model.subarray(end)]) {
      out.set(part, o);
      o += part.length;
    }
    return out.subarray(0, o);
  }
  throw new Error("speech model: no graph");
}

function bytes(n: number) {
  const out: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) out.push((n & 127) | 128);
  out.push(n);
  return out;
}

type Ids = { data: ArrayLike<bigint> };
type Tts = {
  model: (inputs: { input_ids: Ids }) => Promise<Record<string, { data: ArrayLike<number | bigint> }>>;
  tokenizer: { decode(ids: number[]): string };
};

const made = new WeakMap<object, Timing>();

// The TTS, keeping each sentence's timing for its audio, for timing().
export function timed<T>(tts: T): T {
  const t = tts as unknown as Tts;
  const run = t.model;
  t.model = async (inputs) => {
    const out = await run(inputs);
    const durations = out[DURATIONS];
    if (durations) {
      const ids = Array.from(inputs.input_ids.data, Number);
      made.set(out.waveform.data, { phonemes: ids.map((id) => [...t.tokenizer.decode([id])][0] ?? "$").join(""), frames: Array.from(durations.data, Number) });
    }
    return out;
  };
  return tts;
}

export const timing = (audio: object): Timing | undefined => made.get(audio);
