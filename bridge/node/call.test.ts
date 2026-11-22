import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { lines } from "../hub";
import type { PeerEvent } from "../peers";
import { RATE } from "../transcribe";
import { type CallModels, answer, spoken } from "./call";
import { Confirms } from "./confirm";
import type { Sessions } from "./mcp";
import { ORIGIN, setup } from "./testing";

// A voice call with Pepper (call.ts), with models that read the audio made
// here: a sample's value is its phrase / 100 (silence 0), so the VAD hears
// speech where it isn't 0 and the transcriber says the phrase. Speech is
// as long as its text (a ms a letter, or seconds if set), and waits while
// held is.
const PHRASES = ["", "what does my day look like", "yes", "no", "go ahead please", "tell corkboard to push"];
const speech = (ms: number, phrase: number) => new Float32Array(Math.round((ms / 1000) * RATE)).fill(phrase / 100);
const silence = (ms: number) => new Float32Array(Math.round((ms / 1000) * RATE));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, i), (i += p.length);
  return out;
};
const pcm = (audio: Float32Array) => Buffer.from(Int16Array.from(audio, (x) => x * 0x7fff).buffer).toString("base64");

let held: Promise<void> | null = null;
let seconds = 0;
let making = 0;
const models: CallModels = {
  vad: () => ({ next: async (f) => (f.some((x) => x !== 0) ? 0.9 : 0.01) }),
  transcribe: async (audio) => {
    const codes = [...new Set(Array.from(audio, (x) => Math.round(x * 100)).filter((x) => x))];
    return codes.map((c) => PHRASES[c]).join(" ");
  },
  say: async (text) => {
    await held;
    if (making) await Bun.sleep(making);
    return { audio: new Float32Array(seconds ? seconds * 24_000 : text.length * 24).fill(0.5), rate: 24_000 };
  },
  phonemes: async (text) => text.toLowerCase(),
};

describe("a voice call with Pepper", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  const confirms = new Confirms();
  const fns = new Set<(e: PeerEvent) => void>();
  const sessions: Sessions = { list: () => [], fetch: async () => Response.json({}), on: (fn) => (fns.add(fn), () => void fns.delete(fn)) };
  let phone: string;
  beforeAll(async () => {
    n = await setup({ confirms, sessions, callModels: models });
    phone = n.oauth.mint("phone", 1);
  });
  afterAll(() => n.stop());

  const LOCAL = { requestIP: () => ({ address: "127.0.0.1" }) } as any;
  // A call from the phone: what it sends, and everything the node says.
  async function dial(o: { token?: string; peer?: any; query?: string } = {}) {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c), cancel: () => void (cancelled = true) });
    const res = await n.app(
      new Request(`${ORIGIN}/api/node/call?voice=af_heart${o.query ?? ""}`, { method: "POST", headers: { Authorization: `Bearer ${o.token ?? phone}` }, body, duplex: "half" } as RequestInit),
      o.peer === undefined ? LOCAL : o.peer,
    );
    const got: any[] = [];
    const over = res.ok && res.body ? lines(res.body, (m) => got.push(m)) : Promise.resolve();
    const send = (m: object) => push.enqueue(new TextEncoder().encode(JSON.stringify(m) + "\n"));
    return {
      res,
      got,
      over,
      send,
      say: (audio: Float32Array) => send({ type: "audio", data: pcm(audio) }),
      hangUp: () => (send({ type: "end" }), over),
      close: () => push.close(),
      cancelled: () => cancelled,
      async until(test: (m: any) => boolean, ms = 2000) {
        for (let i = 0; i < ms / 10; i++) {
          const m = got.find(test);
          if (m) return m;
          await Bun.sleep(10);
        }
        throw new Error(`never said; said ${JSON.stringify(got.map((m) => m.type))}`);
      },
    };
  }
  const lastChat = () => n.data.chat(undefined, 1).at(-1)!;

  it("is the user's own, sealed", async () => {
    const pepper = n.oauth.mint("pepper", 1, "assistant", "assistant", true);
    expect((await dial({ token: pepper })).res.status).toBe(404);
    expect((await dial({ peer: null })).res.status).toBe(404);
  });

  it("posts what's said to the chat as the user's, from the call, and says Pepper's answer a sentence at a time", async () => {
    const c = await dial();
    c.say(join(silence(300), speech(1200, 1), silence(1000)));
    expect(await c.until((m) => m.type === "heard")).toEqual({ type: "heard", text: PHRASES[1] });
    await Bun.sleep(20);
    expect(lastChat()).toMatchObject({ who: "call", text: PHRASES[1], by_user: true, delivered: null });

    await n.data.post("assistant", "Two meetings today. **Lunch** at noon,\nwith [Sam](https://x.test).");
    await c.until((m) => m.type === "say" && m.text === "with Sam.");
    const says = c.got.filter((m) => m.type === "say");
    expect(says.map((m) => m.text)).toEqual(["Two meetings today.", "Lunch at noon,", "with Sam."]);
    expect(says[0].rate).toBe(24_000);
    expect(Buffer.from(says[0].audio, "base64").length).toBe("Two meetings today.".length * 24 * 2);
    // Its own words aren't said back.
    expect(says.some((m) => m.text === PHRASES[1])).toBe(false);
    await c.hangUp();
  });

  it("stops talking when the user talks over it, and drops what it hadn't said", async () => {
    const c = await dial();
    let open!: () => void;
    held = new Promise((r) => (open = r));
    await n.data.post("assistant", "One. Two. Three.");
    await Bun.sleep(20);
    c.say(speech(300, 1));
    await c.until((m) => m.type === "stop");
    open();
    held = null;
    c.say(silence(1000));
    await c.until((m) => m.type === "heard");
    await Bun.sleep(50);
    expect(c.got.filter((m) => m.type === "say")).toEqual([]);
    await c.hangUp();
  });

  it("makes each sentence only as the phone is about to need it, so talking over a long answer is heard at once", async () => {
    const c = await dial();
    seconds = 3;
    await n.data.post("assistant", "One. Two. Three.");
    await c.until((m) => m.type === "say");
    await Bun.sleep(300);
    expect(c.got.filter((m) => m.type === "say").map((m) => m.text)).toEqual(["One."]);
    c.say(speech(300, 1));
    await c.until((m) => m.type === "stop");
    seconds = 0;
    // Past when the second would have been made.
    await Bun.sleep(1500);
    expect(c.got.filter((m) => m.type === "say")).toHaveLength(1);
    await c.hangUp();
  });

  it("starts the next sentence as long before the last ends as it takes to make, so a slow voice leaves no gap", async () => {
    const c = await dial();
    [seconds, making] = [2, 1800];
    await n.data.post("assistant", "One. Two.");
    await c.until((m) => m.type === "say", 4000);
    const first = Date.now();
    await c.until((m) => m.type === "say" && m.text === "Two.", 4000);
    [seconds, making] = [0, 0];
    expect(Date.now() - first).toBeLessThan(2000);
    await c.hangUp();
  });

  it("sends the phone every sentence's phonemes at once when it makes the voice, and stops it until it says it's played them", async () => {
    const c = await dial({ query: "&speak=phone" });
    seconds = 3;
    await n.data.post("assistant", "One. Two. Three.");
    await c.until((m) => m.type === "say" && m.text === "Three.");
    seconds = 0;
    expect(c.got.filter((m) => m.type === "say")).toEqual([
      { type: "say", text: "One.", phonemes: "one." },
      { type: "say", text: "Two.", phonemes: "two." },
      { type: "say", text: "Three.", phonemes: "three." },
    ]);
    c.say(join(speech(300, 1), silence(1000)));
    await c.until((m) => m.type === "stop");
    await c.until((m) => m.type === "heard");
    // Played, talking isn't stopping anything.
    c.got.length = 0;
    c.send({ type: "played", n: 3 });
    await Bun.sleep(20);
    c.say(join(speech(300, 1), silence(1000)));
    await c.until((m) => m.type === "heard");
    expect(c.got.some((m) => m.type === "stop")).toBe(false);
    await c.hangUp();
  });

  it("decides what waits with a spoken yes or no, in the node, and tells Pepper what came of it", async () => {
    const c = await dial();
    let ran = 0;
    const h = confirms.hold("assistant", "session_say", 'type "1" in corkboard on laptop', async () => ++ran);
    expect(await c.until((m) => m.type === "confirm")).toEqual({ type: "confirm", id: h.id, what: h.what });
    c.say(join(speech(500, 4), silence(1000)));
    expect(await c.until((m) => m.type === "decided")).toEqual({ type: "decided", id: h.id, state: "done" });
    expect(ran).toBe(1);
    await Bun.sleep(20);
    expect(lastChat()).toMatchObject({ who: "call", text: 'Yes to "type "1" in corkboard on laptop". It\'s done.', by_user: true });

    const no = confirms.hold("assistant", "spawn_stop", "stop the spawn sp1", async () => ++ran);
    c.say(join(speech(500, 3), silence(1000)));
    expect(await c.until((m) => m.type === "decided" && m.id === no.id)).toMatchObject({ state: "refused" });
    expect(ran).toBe(1);

    // With nothing waiting, a yes is Pepper's.
    c.say(join(speech(500, 2), silence(1000)));
    await c.until((m) => m.type === "heard" && m.text === "yes");
    await Bun.sleep(20);
    expect(lastChat()).toMatchObject({ who: "call", text: "yes" });
    await c.hangUp();
  });

  it("tells Pepper of a session that starts asking, once", async () => {
    const c = await dial();
    const bridge = (state: string) => ({ id: "laptop-8080", machine: "laptop", url: null, environment: null, device: "laptop", sessions: [{ key: "3-12", project: "corkboard", state, detail: "Bash: git push" }] });
    for (const fn of fns) fn(bridge("working"));
    for (const fn of fns) fn(bridge("permission"));
    for (const fn of fns) fn(bridge("permission"));
    await Bun.sleep(20);
    const told = n.data.chat(undefined, 5).filter((m) => m.who === "away");
    expect(told.map((m) => m.text)).toEqual(["corkboard on laptop wants permission: Bash: git push (bridge laptop-8080, key 3-12)"]);
    expect(told[0].by_user).toBe(true);
    await c.hangUp();
    // Not once it's over.
    expect(fns.size).toBe(0);
  });

  it("still hears what was being said when the phone hangs up", async () => {
    const c = await dial();
    c.say(speech(800, 5));
    await c.hangUp();
    expect(c.got).toContainEqual({ type: "heard", text: PHRASES[5] });
    expect(lastChat()).toMatchObject({ who: "call", text: PHRASES[5] });
  });

  it("reads what the phone sends after it hangs up to its end, and lets go of nothing", async () => {
    const c = await dial();
    await c.hangUp();
    c.say(speech(800, 2));
    c.close();
    await Bun.sleep(20);
    expect(c.cancelled()).toBe(false);
    expect(c.got.some((m) => m.type === "heard")).toBe(false);
  });

  it("takes only a whole yes or no as one", () => {
    for (const t of ["Yes.", "yeah", "Go ahead, please.", "OK do it", "sure"]) expect(answer(t)).toBe(true);
    for (const t of ["No.", "nope", "Cancel it", "don't"]) expect(answer(t)).toBe(false);
    for (const t of ["yes but type 2 instead", "no idea", "what does it do"]) expect(answer(t)).toBeUndefined();
  });

  it("says a message's words, not its markdown or code", () => {
    expect(spoken("# Plan\n- **one** thing.\n- `two`\n```\ncode\n```\nDone!")).toEqual(["Plan", "one thing.", "two", "Done!"]);
  });

  it("cuts a long first sentence at a clause, so the first of it is heard sooner", () => {
    expect(spoken("Morning is the terminal UI from nine to eleven thirty, then referral messages. After that, lunch with Sam today.")).toEqual([
      "Morning is the terminal UI from nine to eleven thirty,",
      "then referral messages.",
      "After that, lunch with Sam today.",
    ]);
    expect(spoken("Yes, so the plan for today is waiting for you to accept it.")).toEqual(["Yes, so the plan for today is waiting for you to accept it."]);
    expect(spoken("Okay, I can hear you.")).toEqual(["Okay, I can hear you."]);
  });
});
