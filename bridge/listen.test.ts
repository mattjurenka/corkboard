// A meeting's hearing (listen.ts) on audio made here, with models that
// read it: a sample's value says who is speaking and what (speaker / 10 +
// phrase / 1000, silence 0), so the VAD hears speech where it isn't 0, the
// transcriber says the phrases in it, and a voice is its speaker's. What's
// tested is listen.ts's own: where utterances are cut, who is who, what's
// an echo, the partial line, and chunks that overlap.
import { describe, expect, it } from "bun:test";
import { type Heard, type Line, type Models, hear } from "./listen";
import { RATE } from "./transcribe";

const PHRASES = ["", "we ship on friday morning", "i will send the deck", "sounds good to me", "can you hear me", "the budget is fine", "the room says hello"];

const speech = (ms: number, speaker: number, phrase: number) => new Float32Array(Math.round((ms / 1000) * RATE)).fill(speaker / 10 + phrase / 1000);
const silence = (ms: number) => new Float32Array(Math.round((ms / 1000) * RATE));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, i), (i += p.length);
  return out;
};
const codes = (audio: Float32Array) => [...new Set(Array.from(audio).filter((x) => x !== 0))];

function models(o: { fail?: number } = {}): Models & { transcribed: number } {
  const m = {
    transcribed: 0,
    vad: () => ({ next: async (f: Float32Array) => (f.some((x) => x !== 0) ? 0.9 : 0.01) }),
    transcribe: async (audio: Float32Array) => {
      m.transcribed++;
      const phrases = codes(audio).map((x) => Math.round((x * 1000) % 100));
      if (o.fail !== undefined && phrases.includes(o.fail)) throw new Error("the model fell over");
      return phrases.map((p) => PHRASES[p]).join(" ").trim();
    },
    voice: async (audio: Float32Array) => {
      const v = new Float32Array(10);
      v[Math.floor(codes(audio)[0] * 10 + 1e-6)] = 1;
      return v;
    },
  };
  return m;
}

const blank = (): Heard => ({ lines: [], voices: { out: [], in: [] }, who: { out: [], in: [] }, partial: {}, heard: { out: 0, in: 0 } });
// Who said each line, and what.
const said = (h: Heard) => h.lines.map((l) => [h.who[l.track][l.speaker], l.text]);

describe("a meeting's hearing", () => {
  it("cuts a track into lines where it's quiet, and tells the voices on it apart", async () => {
    const h = blank();
    const errors: Error[] = [];
    const ear = hear(h, () => {}, (e) => errors.push(e), false, models());
    await ear.ears.out.push(join(speech(1500, 1, 1), silence(1000), speech(1500, 2, 2), silence(1000), speech(1200, 1, 3), silence(1000)));
    await ear.done();
    expect(said(h)).toEqual([
      ["Them 1", PHRASES[1]],
      ["Them 2", PHRASES[2]],
      ["Them 1", PHRASES[3]],
    ]);
    expect(errors).toEqual([]);
    // Each from where it started, with a little quiet kept after it.
    const [a, b] = h.lines;
    expect(a.start).toBe(0);
    expect(a.stop).toBeGreaterThanOrEqual(1500);
    expect(a.stop).toBeLessThanOrEqual(1750);
    expect(b.start).toBeGreaterThanOrEqual(2300);
    expect(b.start).toBeLessThanOrEqual(2500);
    expect(h.heard.out).toBeGreaterThanOrEqual(h.lines[2].stop);
  });

  it("calls whoever said the most into the mic Me, and the others the room", async () => {
    const h = blank();
    const ear = hear(h, () => {}, () => {}, false, models());
    await ear.ears.in.push(join(speech(1200, 4, 6), silence(1000), speech(3000, 3, 4), silence(1000)));
    await ear.done();
    expect(said(h)).toEqual([
      ["Room 1", PHRASES[6]],
      ["Me", PHRASES[4]],
    ]);
    // Just the one track: the other is Them, unheard.
    expect(h.who.out).toEqual(["Them"]);
  });

  it("drops what the mic heard of the speakers: the same words, or out's voice, at the same time", async () => {
    const h = blank();
    const ear = hear(h, () => {}, () => {}, false, models());
    // The mic first, so the echo is found when out's line comes.
    await ear.ears.in.push(join(speech(1500, 5, 1), silence(1000), speech(1500, 1, 5), silence(1000), speech(1500, 3, 3), silence(1000)));
    await ear.ears.out.push(join(speech(1500, 1, 1), silence(1000), speech(1500, 1, 2), silence(1000)));
    await ear.done();
    // In's first is out's words in another voice; its second, out's voice
    // saying something else; its third is someone in the room.
    expect(said(h)).toEqual([
      ["Them", PHRASES[1]],
      ["Them", PHRASES[2]],
      ["Me", PHRASES[3]],
    ]);
  });

  it("makes no line of nothing said, or of a blip", async () => {
    const h = blank();
    const ear = hear(h, () => {}, () => {}, false, models());
    // Phrase 0 is transcribed as nothing; a frame at the very start is too short.
    await ear.ears.out.push(join(speech(30, 1, 1), silence(1000), speech(1500, 1, 0), silence(1000)));
    await ear.done();
    expect(h.lines).toEqual([]);
  });

  it("shows what's being said as the partial line, until it's a line", async () => {
    const h = blank();
    const partials: string[] = [];
    const ear = hear(h, () => h.partial.out && partials.push(h.partial.out.text), () => {}, true, models());
    await ear.ears.out.push(speech(2500, 1, 1));
    await Bun.sleep(50);
    expect(h.partial.out).toEqual({ start: 0, text: PHRASES[1] });
    expect(h.lines).toEqual([]);
    await ear.ears.out.push(silence(1000));
    await ear.done();
    expect(h.partial).toEqual({});
    expect(said(h)).toEqual([["Them", PHRASES[1]]]);
    expect(partials.length).toBeGreaterThan(0);
    // Without partials, it's transcribed once.
    const m = models();
    const quiet = blank();
    const later = hear(quiet, () => {}, () => {}, false, m);
    await later.ears.out.push(join(speech(2500, 1, 1), silence(1000)));
    await later.done();
    expect(m.transcribed).toBe(1);
    expect(quiet.partial).toEqual({});
  });

  it("hears chunks that overlap once, and picks up after a gap where it was", async () => {
    const h = blank();
    const ear = hear(h, () => {}, () => {}, false, models());
    // A chunk's last half second is the next's first, as record.ts's are.
    const first = join(speech(1500, 1, 1), silence(1000));
    const second = join(silence(500), speech(1500, 1, 2), silence(1000));
    await ear.ears.out.push(first, 0);
    await ear.ears.out.push(second, 2000);
    // Then nothing played for a while: the next is when it was.
    await ear.ears.out.push(join(speech(1500, 1, 3), silence(1000)), 60_000);
    await ear.done();
    expect(said(h)).toEqual([
      ["Them", PHRASES[1]],
      ["Them", PHRASES[2]],
      ["Them", PHRASES[3]],
    ]);
    expect(h.lines[1].start).toBeGreaterThanOrEqual(2300);
    expect(h.lines[1].start).toBeLessThanOrEqual(2500);
    expect(h.lines[2].start).toBeGreaterThanOrEqual(60_000 - 200);
    // Heard again from the start (record finish after a crash), what was heard is skipped.
    const again = hear(h, () => {}, () => {}, false, models());
    await again.ears.out.push(first, 0);
    await again.done();
    expect(h.lines.length).toBe(3);
  });

  it("says what it couldn't transcribe, and hears the rest", async () => {
    const h = blank();
    const errors: string[] = [];
    const ear = hear(h, () => {}, (e) => errors.push(e.message), false, models({ fail: 2 }));
    await ear.ears.out.push(join(speech(1500, 1, 1), silence(1000), speech(1500, 1, 2), silence(1000), speech(1500, 1, 3), silence(1000)));
    await ear.done();
    expect(errors).toEqual(["the model fell over"]);
    expect(said(h).map(([, t]) => t)).toEqual([PHRASES[1], PHRASES[3]]);
  });

  it("takes a hearing as a meeting.json had it, with parts missing", async () => {
    const h = { lines: [] as Line[] } as unknown as Heard;
    const ear = hear(h, () => {}, () => {}, false, models());
    await ear.ears.in.push(join(speech(1500, 3, 4), silence(1000)));
    await ear.done();
    expect(said(h)).toEqual([["Me", PHRASES[4]]]);
    expect(h.heard.in).toBeGreaterThan(0);
  });
});
