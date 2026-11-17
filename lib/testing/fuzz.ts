// Fuzzing and property tests with no library: a seeded generator, so a
// failure prints the seed that reruns it, and a fuzz() that runs a body
// over many seeds as one bun test.
//
//   FUZZ_RUNS=5000 bun test lib/e2ee/test/*.fuzz.test.ts   longer
//   FUZZ_SEED=1234 bun test …                              that one again
//
// The default runs are few, so CI's bun test stays quick.

import { it } from "bun:test";

// sfc32, seeded through splitmix32: fast, and good enough for picking inputs.
export function rng(seed: number) {
  let s = seed >>> 0;
  const mix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = mix(),
    b = mix(),
    c = mix(),
    d = mix();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 2 ** 32;
  };
  return new Gen(next);
}

// Strings a parser is likely to trip on, beside random ones.
const NASTY = ["", "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "\0", " ", "\ud800", "😀", "-1", "NaN", "1e309", "../", "%00", "a".repeat(300)];

export class Gen {
  constructor(readonly next: () => number) {}

  // An integer in [lo, hi].
  int(lo: number, hi: number) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5) {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  // Mostly small, now and then big: where the edges are.
  size(max: number) {
    const r = this.next();
    if (r < 0.1) return 0;
    if (r < 0.2) return max;
    if (r < 0.7) return this.int(0, Math.min(max, 16));
    return this.int(0, max);
  }
  bytes(max = 64) {
    const out = new Uint8Array(this.size(max));
    for (let i = 0; i < out.length; i++) out[i] = this.int(0, 255);
    return out;
  }
  string(max = 16) {
    if (this.bool(0.2)) return this.pick(NASTY);
    const n = this.size(max);
    let s = "";
    for (let i = 0; i < n; i++) s += this.bool(0.9) ? String.fromCharCode(this.int(0x20, 0x7e)) : String.fromCodePoint(this.int(0, 0x10ffff));
    return s;
  }
  // A key from the dictionary given, or the nasty ones, or any.
  key(known: readonly string[] = []) {
    const r = this.next();
    if (known.length && r < 0.6) return this.pick(known);
    if (r < 0.8) return this.pick(NASTY);
    return this.string(8);
  }
  // Any JSON value, shaped around the keys given.
  json(depth = 3, keys: readonly string[] = []): unknown {
    const r = this.int(0, depth > 0 ? 9 : 5);
    if (r === 0) return null;
    if (r === 1) return this.bool();
    if (r === 2) return this.pick([0, 1, -1, 2 ** 53, -(2 ** 53), 0.5, 1e300, this.int(-1000, 1000)]);
    if (r <= 5) return this.string();
    if (r <= 6) return Array.from({ length: this.size(6) }, () => this.json(depth - 1, keys));
    const o: Record<string, unknown> = {};
    for (let n = this.size(6); n > 0; n--) Object.defineProperty(o, this.key(keys), { value: this.json(depth - 1, keys), enumerable: true, writable: true, configurable: true });
    return o;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // A small change to some bytes: one flipped, cut short, grown, or replaced.
  mutate(b: Uint8Array): Uint8Array {
    const out = b.slice();
    switch (this.int(0, 3)) {
      case 0:
        if (!out.length) return new Uint8Array([this.int(0, 255)]);
        out[this.int(0, out.length - 1)] ^= 1 << this.int(0, 7);
        return out;
      case 1:
        return out.subarray(0, this.int(0, Math.max(0, out.length - 1)));
      case 2: {
        const more = new Uint8Array(out.length + this.int(1, 8));
        more.set(out);
        return more;
      }
      default:
        return this.bytes(out.length + 8);
    }
  }
}

const RUNS = Number(process.env.FUZZ_RUNS) || 0;
const SEED = process.env.FUZZ_SEED === undefined ? undefined : Number(process.env.FUZZ_SEED);

// A test that runs body once per seed; runs is the default, FUZZ_RUNS any
// other, FUZZ_SEED just the one. The seed it failed at is in the error.
export function fuzz(name: string, body: (g: Gen, seed: number) => void | Promise<void>, o: { runs?: number; timeout?: number } = {}) {
  const runs = RUNS || o.runs || 100;
  const base = SEED ?? (Number(process.env.FUZZ_BASE) || 1);
  it(
    name,
    async () => {
      for (let k = 0; k < (SEED === undefined ? runs : 1); k++) {
        const seed = base + k;
        try {
          await body(rng(seed), seed);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          err.message = `FUZZ_SEED=${seed}: ${err.message}`;
          throw err;
        }
      }
    },
    o.timeout ?? Math.max(5000, runs * 200),
  );
}
