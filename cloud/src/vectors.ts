// Recall by meaning, for memory.ts: what a note or an entry is embedded as,
// and the embedding itself (Workers AI), kept in Vectorize. One index for
// every memory, a namespace per brain, so one brain's vectors never answer
// another's query.

export const MODEL = "@cf/baai/bge-m3";
// bge-m3 reads 8192 tokens; a chunk is far under, so a long note is found by
// the part that matches rather than diluted into one vector.
const CHUNK = 1500;
const OVERLAP = 200;
// Texts per Workers AI call.
const BATCH = 50;

// A note in pieces of about CHUNK characters, cut at paragraphs where it can,
// each after the first starting a little before the last one ended. Every
// piece carries the title, so it says what it's from.
export function chunks(title: string, body: string): string[] {
  const text = body.trim();
  if (text.length <= CHUNK) return [`${title}\n\n${text}`];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK);
    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      const cut = para > start + CHUNK / 2 ? para : line > start + CHUNK / 2 ? line : end;
      end = cut;
    }
    out.push(`${title}\n\n${text.slice(start, end).trim()}`);
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out;
}

export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = (await ai.run(MODEL, { text: texts.slice(i, i + BATCH) })) as { data: number[][] };
    out.push(...r.data);
  }
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Vectorize's ids are at most 64 bytes and unique across the index, so a
// chunk's id is a hash of its memory, item and place.
export const vectorId = (namespace: string, item: string, chunk: number) => sha(`${namespace}\n${item}\n${chunk}`).then((h) => h.slice(0, 48));

// A namespace is at most 64 bytes too.
export const namespaceOf = async (user: string, brain: string) => {
  const ns = `${user}/${brain}`;
  return ns.length <= 64 ? ns : `${(await sha(user)).slice(0, 40)}/${brain}`;
};
