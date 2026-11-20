// What the avatar says of Claude's markdown: the text to speak, cut into
// the sentences each said on its own, and what's asked of the voice for them.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { askKey, asks, isMood, sentences, speakable } from "./voice";

describe("speakable", () => {
  test("markdown's marks go, its words stay", () => {
    expect(speakable("# Title\n\n- **bold** and *it* and ~~struck~~\n> quoted\n1. first")).toBe("Title\nbold and it and struck\nquoted\nfirst");
    expect(speakable("Run `bun test` now")).toBe("Run bun test now");
    expect(speakable("See [the docs](http://a.example/x) and ![a cat](cat.png)")).toBe("See the docs and a cat");
  });
  test("code blocks and tables aren't said; a bare link is a link", () => {
    expect(speakable("Before.\n```ts\nconst x = 1;\n```\nAfter.")).toBe("Before.\n \nAfter.");
    expect(speakable("| a | b |\n|---|---|\n| 1 | 2 |\nDone.")).toBe("Done.");
    expect(speakable("Go to https://a.example/x?y=1 now")).toBe("Go to a link now");
  });
});

describe("sentences", () => {
  test("one each, by their stops", () => {
    expect(sentences("Hello there, friend. How are you doing today? I'm doing well!")).toEqual([
      "Hello there, friend.",
      "How are you doing today?",
      "I'm doing well!",
    ]);
    expect(sentences("Here is the plan: first this, then that.")).toEqual(["Here is the plan:", "first this, then that."]);
    expect(sentences("Line one goes here\nLine two goes here")).toEqual(["Line one goes here", "Line two goes here"]);
  });

  test("a scrap goes with the one before it", () => {
    expect(sentences("Ok. Yes. Fine.")).toEqual(["Ok. Yes. Fine."]);
    expect(sentences("This sentence is long enough. Yes.")).toEqual(["This sentence is long enough. Yes."]);
  });

  test("nothing for nothing, or for what isn't said", () => {
    expect(sentences("")).toEqual([]);
    expect(sentences("   \n\n ")).toEqual([]);
    expect(sentences("```\ncode only\n```")).toEqual([]);
  });

  test("a long sentence in parts no longer than 200, at a space", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ".";
    const out = sentences(words);
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(200);
    expect(out.join(" ")).toBe(words);
    // And with no space to cut at, at 200.
    expect(sentences("a".repeat(450)).map((s) => s.length)).toEqual([200, 200, 50]);
  });

  test("a long first sentence a clause at a time, so the first is heard sooner", () => {
    const s = "This is a very long first sentence, which goes on and on with its commas; and semicolons — and dashes, until it ends.";
    const out = sentences(s);
    expect(out[0]).toBe("This is a very long first sentence,");
    expect(out.join(" ")).toBe(s);
  });
});

fuzz("sentences say all of what's speakable, in parts no longer than 200", (g) => {
  const pieces = [". ", "! ", "? ", ": ", ", ", "; ", " — ", "\n", "\n\n", " ", "word", "a", "longerword", "**", "`", "# ", "- ", "https://a.example/x"];
  let md = "";
  for (let n = g.size(200); n > 0; n--) md += g.bool(0.85) ? g.pick(pieces) : g.string(6);
  const out = sentences(md);
  for (const s of out) {
    expect(s.length).toBeLessThanOrEqual(200 + 12);
    expect(s).toBe(s.trim());
    expect(s).not.toBe("");
  }
  const squash = (s: string) => s.replace(/\s+/g, "");
  expect(squash(out.join(""))).toBe(squash(speakable(md)));
});

describe("asks", () => {
  test("a sentence of each, at the mood's speed", () => {
    expect(asks("Hello there, friend. How are you doing today?", "af_heart", "sad")).toEqual([
      { text: "Hello there, friend.", voice: "af_heart", speed: 0.88, mood: "sad", recorded: undefined },
      { text: "How are you doing today?", voice: "af_heart", speed: 0.88, mood: "sad", recorded: undefined },
    ]);
    expect(asks("Hello there, friend.", "af_heart")[0].speed).toBe(1);
  });

  test("anime is af_anime, and its interjections are recordings, not asked", () => {
    expect(asks("Gasp! That was a surprise. Hahaha!", "anime")).toEqual([{ text: "That was a surprise.", voice: "af_anime", speed: 1, mood: undefined, recorded: undefined }]);
    expect(asks("What?! Why?! Hey!", "anime")).toEqual([]);
    // Another voice says them.
    expect(asks("Gasp! That was a surprise.", "af_heart").map((a) => a.text)).toEqual(["Gasp!", "That was a surprise."]);
  });

  test("words Kokoro says wrong, respelt; a stutter as the word", () => {
    expect(asks("You baka, hmph.", "af_heart")[0].text).toBe("You bah-kah, hmmf.");
    expect(asks("H-hey there, you.", "af_heart")[0].text).toBe("hey there, you.");
    expect(asks("I-I think so.", "af_heart")[0].text).toBe("I think so.");
  });

  test("a voice named like an Object method is that voice", () => {
    expect(asks("Hello there, friend.", "constructor")[0]).toMatchObject({ voice: "constructor", speed: 1 });
  });

  test("askKey tells asks apart by all they're asked", () => {
    const [a] = asks("Hello there, friend.", "af_heart", "happy");
    expect(askKey(a)).toBe("af_heart\n1.05\nhappy\nHello there, friend.");
    expect(askKey({ ...a, mood: undefined })).toBe("af_heart\n1.05\n\nHello there, friend.");
  });
});

test("isMood", () => {
  for (const m of ["happy", "excited", "teasing", "annoyed", "sulky", "shy", "sad", "surprised"]) expect(isMood(m)).toBe(true);
  for (const m of ["", "angry", "constructor", "toString", "__proto__", 1, null, undefined, {}]) expect(isMood(m)).toBe(false);
});
