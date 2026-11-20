// Key sequences as the page shows them (the palette, the key hints), off a
// Mac; and the one of a binding's keys it shows.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { MAC } from "@/nvim/input.js";
import { keysFor, prettyKeys } from "./keys";

test("this isn't a Mac", () => expect(MAC).toBe(false));

describe("prettyKeys", () => {
  test("chords in the order and words of the platform", () => {
    expect(prettyKeys("<C-S-p>")).toBe("Ctrl+Shift+P");
    expect(prettyKeys("<S-C-p>")).toBe("Ctrl+Shift+P");
    expect(prettyKeys("<A-D-h>")).toBe("Alt+Cmd+H");
    expect(prettyKeys("<M-x>")).toBe("Alt+X");
    expect(prettyKeys("<c-a>")).toBe("Ctrl+A");
  });

  test("Neovim's capital letters: Shift, but not on a Ctrl chord", () => {
    expect(prettyKeys("<D-P>")).toBe("Shift+Cmd+P");
    expect(prettyKeys("<C-T>")).toBe("Ctrl+T");
    expect(prettyKeys("<D-S-P>")).toBe("Shift+Cmd+P");
  });

  test("named keys, with or without a chord", () => {
    expect(prettyKeys("<CR>")).toBe("Enter");
    expect(prettyKeys("<Esc>")).toBe("Esc");
    expect(prettyKeys("<C-Space>")).toBe("Ctrl+Space");
    expect(prettyKeys("<lt>")).toBe("<");
    expect(prettyKeys("<Bslash>")).toBe("\\");
    expect(prettyKeys("<Bar>")).toBe("|");
    expect(prettyKeys("<A-Left>")).toBe("Alt+←");
    expect(prettyKeys("<C-k0>")).toBe("Ctrl+Numpad0");
    expect(prettyKeys("<F5>")).toBe("F5");
  });

  test("a sequence is its keys apart, the leader as it's set", () => {
    expect(prettyKeys("gd")).toBe("g d");
    expect(prettyKeys("<leader>ff")).toBe("\\ f f");
    expect(prettyKeys("<Leader>ff", " ")).toBe("Space f f");
    expect(prettyKeys("<leader>x", ",")).toBe(", x");
    expect(prettyKeys(" a")).toBe("Space a");
    expect(prettyKeys("<C-w>j")).toBe("Ctrl+W j");
  });

  test("what isn't a chord is as it was, a name without its brackets", () => {
    expect(prettyKeys("<")).toBe("<");
    expect(prettyKeys("<>")).toBe("< >");
    expect(prettyKeys("<X-a>")).toBe("X-a");
    expect(prettyKeys("")).toBe("");
  });

  // NAMES and MODS are read by own key: a key named like an Object method is
  // only its name.
  test("a key named like an Object method", () => {
    expect(prettyKeys("<constructor>")).toBe("constructor");
    expect(prettyKeys("<C-toString>")).toBe("Ctrl+toString");
    expect(prettyKeys("<C-__proto__>")).toBe("Ctrl+__proto__");
  });
});

fuzz("prettyKeys takes anything", (g) => {
  const parts = ["<", ">", "C-", "S-", "D-", "A-", "M-", "leader", "CR", "lt", "a", "P", " "];
  let s = "";
  for (let n = g.size(12); n > 0; n--) s += g.bool(0.7) ? g.pick(parts) : g.string(4);
  expect(typeof prettyKeys(s, g.pick(["\\", " ", ","]))).toBe("string");
});

describe("keysFor", () => {
  test("off a Mac, the first key that isn't a Cmd chord", () => {
    expect(keysFor(["<D-p>", "<C-p>", "<C-S-p>"])).toBe("<C-p>");
    expect(keysFor(["<A-D-h>", "<A-h>"])).toBe("<A-h>");
    expect(keysFor(["gp"])).toBe("gp");
  });
  test("none when there are only Cmd chords, or no keys", () => {
    expect(keysFor(["<D-p>", "<S-D-p>"])).toBeUndefined();
    expect(keysFor([])).toBeUndefined();
    expect(keysFor(undefined)).toBeUndefined();
  });
});
