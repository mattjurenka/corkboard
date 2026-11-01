// Voices of our own for Kokoro, grown from a recording with KVoiceWalk:
// each a style vector for every length of sentence, 510 by 256 float32s,
// as Kokoro's are, in web/public/voices/<name>.bin. kokoro-js only knows its
// own, so its KokoroTTS is taught these: said as American English, with the
// style it would have taken from its own voice's file taken from ours.
// Used by bridge/speech.ts and the page's web/src/avatar/kokoro.worker.ts.

export const OWN_VOICES = ["af_anime"];

type Floats = { data: Float32Array; dims: number[] };
type Tts = {
  model(inputs: Record<string, unknown>): Promise<{ waveform: Floats }>;
  _validate_voice(voice: string): string;
  generate_from_ids(ids: Floats, opts: { voice?: string; speed?: number }): Promise<unknown>;
};

export function ownVoices<T>(
  tts: T,
  Tensor: new (type: "float32", data: Float32Array | number[], dims: number[]) => unknown,
  read: (name: string) => Promise<ArrayBuffer>,
): T {
  const t = tts as unknown as Tts;
  const styles = new Map<string, Promise<Float32Array>>();
  const validate = t._validate_voice.bind(t);
  const fromIds = t.generate_from_ids.bind(t);
  t._validate_voice = (voice) => (OWN_VOICES.includes(voice) ? "a" : validate(voice));
  t.generate_from_ids = async (ids, { voice = "", speed = 1 }) => {
    if (!OWN_VOICES.includes(voice)) return fromIds(ids, { voice, speed });
    if (!styles.has(voice)) styles.set(voice, read(voice).then((b) => new Float32Array(b)));
    const all = await styles.get(voice)!.catch((err) => {
      styles.delete(voice);
      throw err;
    });
    // As kokoro-js does: the style for a sentence of this many tokens.
    const at = 256 * Math.min(Math.max(ids.dims[ids.dims.length - 1] - 2, 0), 509);
    const { waveform } = await t.model({
      input_ids: ids,
      style: new Tensor("float32", all.slice(at, at + 256), [1, 256]),
      speed: new Tensor("float32", [speed], [1]),
    });
    return { audio: waveform.data, sampling_rate: 24000 };
  };
  return tts;
}
