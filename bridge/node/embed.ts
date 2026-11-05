// Recall by meaning on the node: search.ts's Embedder, with a small model
// run here (transformers.js, as speech.ts runs Kokoro) rather than the
// Worker's bge-m3 in Workers AI (.agent/plans/local-memory.md).
//
// A text is embedded once for the account: the node that wrote it (the one
// a session ran on) makes its vector and shares it, as a `vector:<hash>`
// record in the brain's encrypted replica, quantized to a byte a dimension;
// the other devices take it from there. The hash is of the model and the
// text, so changing the model only embeds again, and the vectors of texts
// that are gone are dropped by the next node to embed.
//
// A long note is embedded in pieces, as the Worker's were, so it's found by
// the part that matches; an item scores as its best piece.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { CACHE_DIR, COMPILED, RESOURCES } from "../dirs";
import type { Data } from "./data";
import type { Embedder } from "./search";

// English, 384 dimensions, about 34 MB quantized; it reads 512 tokens.
export const MODEL = "Xenova/bge-small-en-v1.5";
// bge's queries are asked with this before them; the passages aren't.
const QUERY = "Represent this sentence for searching relevant passages: ";
const CHUNK = 1500;
const OVERLAP = 200;
const BATCH = 32;
const TOP = 40;

// Texts to unit vectors; a query's are made as a question's.
export type Embed = (texts: string[], query?: boolean) => Promise<Float32Array[]>;

// Beside the compiled bridge, as speech.ts's sidecar finds it.
const transformers = (): Promise<typeof import("@huggingface/transformers")> =>
  import(COMPILED ? Bun.resolveSync("@huggingface/transformers", join(RESOURCES, "speech.js")) : "@huggingface/transformers");

let extractor: Promise<any> | undefined;
export const bge: Embed = async (texts, query = false) => {
  extractor ??= transformers()
    .then((t) => {
      t.env.cacheDir = join(CACHE_DIR, "models");
      return t.pipeline("feature-extraction", MODEL, { dtype: "q8" });
    })
    .catch((e) => {
      extractor = undefined;
      throw e;
    });
  const out = await (await extractor)(query ? texts.map((t) => QUERY + t) : texts, { pooling: "cls", normalize: true });
  const [n, dim] = out.dims as number[];
  const data = out.data as Float32Array;
  return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
};

// A text in pieces of about CHUNK characters, cut at paragraphs where it
// can, each after the first starting a little before the last one ended;
// every piece carries the first line (a note's title), so it says what it's from.
export function pieces(text: string): string[] {
  if (text.length <= CHUNK) return [text];
  const nl = text.indexOf("\n");
  const head = nl > 0 && nl < 200 ? text.slice(0, nl) : "";
  const body = head ? text.slice(nl + 1).trim() : text;
  const out: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + CHUNK);
    if (end < body.length) {
      const para = body.lastIndexOf("\n\n", end);
      const line = body.lastIndexOf("\n", end);
      end = para > start + CHUNK / 2 ? para : line > start + CHUNK / 2 ? line : end;
    }
    out.push(`${head ? head + "\n\n" : ""}${body.slice(start, end).trim()}`);
    if (end >= body.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out;
}

// A unit vector as bytes and a scale, and back.
export function quantize(v: Float32Array): { q: string; s: number } {
  const scale = Math.max(1e-9, ...v.map(Math.abs)) / 127;
  return { q: Buffer.from(Int8Array.from(v, (x) => Math.round(x / scale)).buffer).toString("base64url"), s: scale };
}

export function dequantize(r: { q: string; s: number }): Float32Array {
  const b = Buffer.from(r.q, "base64url");
  return Float32Array.from(new Int8Array(b.buffer, b.byteOffset, b.byteLength), (x) => x * r.s);
}

export class LocalEmbedder implements Embedder {
  // Those opened, by hash.
  private vectors = new Map<string, Float32Array>();

  constructor(
    private data: Data,
    private embed: Embed = bge,
    private model = MODEL,
  ) {}

  private hash(text: string) {
    return createHash("sha256").update(`${this.model}\n${text}`).digest("base64url");
  }

  private vector(brain: string, hash: string): Float32Array | undefined {
    let v = this.vectors.get(hash);
    if (!v) {
      const r = this.data.vector(brain, hash);
      if (r) this.vectors.set(hash, (v = dequantize(r)));
    }
    return v;
  }

  // The items' pieces, each with its vector: those no device has made yet
  // made here and shared, and those of texts no longer there dropped.
  async warm(brain: string, items: { key: string; text: string }[]) {
    const all = items.flatMap((it) => pieces(it.text).map((text) => ({ key: it.key, text, hash: this.hash(text) })));
    const missing = [...new Map(all.filter((p) => !this.vector(brain, p.hash)).map((p) => [p.hash, p.text]))];
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vs = await this.embed(batch.map(([, t]) => t));
      const made = batch.map(([hash], j) => ({ hash, ...quantize(vs[j]) }));
      await this.data.putVectors(brain, made);
      for (const m of made) this.vectors.set(m.hash, dequantize(m));
    }
    const live = new Set(all.map((p) => p.hash));
    const gone = this.data.vectorHashes(brain).filter((h) => !live.has(h));
    if (gone.length) await this.data.putVectors(brain, [], gone);
    return all.map((p) => ({ key: p.key, vec: this.vector(brain, p.hash)! }));
  }

  async nearest(brain: string, query: string, items: { key: string; text: string }[]): Promise<string[]> {
    const got = await this.warm(brain, items);
    const [q] = await this.embed([query], true);
    const best = new Map<string, number>();
    for (const { key, vec } of got) {
      let s = 0;
      for (let i = 0; i < q.length; i++) s += q[i] * vec[i];
      if (s > (best.get(key) ?? -Infinity)) best.set(key, s);
    }
    return [...best]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([k]) => k);
  }
}
