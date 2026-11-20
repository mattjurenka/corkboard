// The page after its socket closes: which closes it waits out, and how it
// waits for the bridge to answer again before it reloads.
import { describe, expect, test } from "bun:test";
import { closed, reconnect } from "./reconnect";

describe("closed", () => {
  test("a lost connection or a bridge going away is waited for", () => {
    expect(closed({ code: 1006, reason: "" })).toEqual({ status: "can't reach the bridge — reconnecting", lost: true });
    expect(closed({ code: 1001, reason: "" })).toEqual({ status: "can't reach the bridge — reconnecting", lost: true });
  });
  test("a close the bridge chose stays closed, with its reason", () => {
    expect(closed({ code: 1000, reason: "" })).toEqual({ status: "nvim exited", lost: false });
    expect(closed({ code: 4001, reason: "wrong token" })).toEqual({ status: "wrong token", lost: false });
    expect(closed({ code: 1001, reason: "restarting" })).toEqual({ status: "restarting", lost: true });
  });
});

describe("reconnect", () => {
  // The bridge's answers in turn: true it's up, false a status that isn't
  // ok, an Error no answer at all.
  function run(answers: (boolean | Error)[]) {
    const waits: number[] = [];
    let reloads = 0;
    let asked = 0;
    const done = reconnect({
      sleep: async (ms) => void waits.push(ms),
      probe: async () => {
        const a = answers[asked++];
        if (a instanceof Error) throw a;
        return a;
      },
      reload: () => void reloads++,
    });
    return done.then(() => ({ waits, reloads, asked }));
  }

  test("reloads once the bridge answers, waiting twice as long each time up to 5s", async () => {
    const down = new Error("ECONNREFUSED");
    expect(await run([down, down, false, down, down, down, false, true])).toEqual({
      waits: [500, 1000, 2000, 4000, 5000, 5000, 5000, 5000],
      reloads: 1,
      asked: 8,
    });
  });

  test("at once if it's already back", async () => {
    expect(await run([true])).toEqual({ waits: [500], reloads: 1, asked: 1 });
  });

  test("asks the bridge's manifest, uncached, by default", async () => {
    const was = globalThis.fetch;
    const asked: [string, RequestInit | undefined][] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return new Response(null, { status: asked.length < 2 ? 502 : 200 });
    }) as typeof fetch;
    try {
      let reloaded = false;
      await reconnect({ sleep: async () => {}, reload: () => void (reloaded = true) });
      expect(reloaded).toBe(true);
      expect(asked).toEqual([
        ["manifest.webmanifest", { method: "HEAD", cache: "no-store" }],
        ["manifest.webmanifest", { method: "HEAD", cache: "no-store" }],
      ]);
    } finally {
      globalThis.fetch = was;
    }
  });
});
