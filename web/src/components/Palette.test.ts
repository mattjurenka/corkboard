// The palettes' filter, every letter of the query in order as snacks has it,
// and their up and down.
import { describe, expect, test } from "bun:test";
import { matches, step } from "./Palette";

describe("matches", () => {
  test("every letter in order, any case, any gaps", () => {
    expect(matches("Open project", "opj")).toBe(true);
    expect(matches("Open project", "OP")).toBe(true);
    expect(matches("open project", "Open Project")).toBe(true);
    expect(matches("anything", "")).toBe(true);
  });
  test("not out of order, nor a letter twice that's there once", () => {
    expect(matches("Open project", "jpo")).toBe(false);
    expect(matches("abc", "aa")).toBe(false);
    expect(matches("abc", "abcd")).toBe(false);
    expect(matches("", "a")).toBe(false);
  });
  test("past the start of the text, not a letter found before it", () => {
    expect(matches("ba", "ab")).toBe(false);
    expect(matches("aba", "ab")).toBe(true);
  });
  test("letters that aren't ASCII", () => {
    expect(matches("Ελληνικά", "ελ")).toBe(true);
    expect(matches("中文 study", "中s")).toBe(true);
    expect(matches("😀 face", "😀f")).toBe(true);
  });
});

describe("step", () => {
  const key = (key: string, ctrlKey = false) => {
    const e = { key, ctrlKey, prevented: false, preventDefault: () => void (e.prevented = true) };
    return e;
  };
  const go = (e: ReturnType<typeof key>, at: number, n: number) => step(e as unknown as React.KeyboardEvent, at, n);

  test("arrows and Ctrl+n/p/j/k, held to the list", () => {
    expect(go(key("ArrowDown"), 0, 3)).toBe(1);
    expect(go(key("n", true), 1, 3)).toBe(2);
    expect(go(key("j", true), 2, 3)).toBe(2);
    expect(go(key("ArrowUp"), 2, 3)).toBe(1);
    expect(go(key("p", true), 1, 3)).toBe(0);
    expect(go(key("k", true), 0, 3)).toBe(0);
    expect(go(key("ArrowDown"), 0, 0)).toBe(0);
  });
  test("taken from the field only when it's a step", () => {
    const down = key("ArrowDown");
    go(down, 0, 3);
    expect(down.prevented).toBe(true);
    const j = key("j");
    expect(go(j, 0, 3)).toBeNull();
    expect(j.prevented).toBe(false);
    expect(go(key("Enter"), 0, 3)).toBeNull();
  });
});
