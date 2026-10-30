// Files agents attach to cards: screenshots, plots, recordings, PDFs. The
// bytes are in R2 (MEDIA) at <user>/<board>/<card>/<id>; what each one is
// goes in its card's extra.media, so it reaches every copy of the board with
// the card itself, and read_card shows it.
//
// An agent can't send megabytes in a tool call, so attach_file (mcp.ts)
// either takes a small file inline or offers an upload: a URL, good once for
// an hour, that the agent PUTs the file to (curl -T). The file is on the card
// only once it has arrived.
//
//   PUT   /upload/:token                          the file, as the body; no other auth
//   GET   /api/boards/:board/cards/:id/media/:mid  the file (api.ts)

import type { Env } from "./index";

export type Media = { id: string; name: string; type: string; size: number; at: string; who: string };

// What a request body may be: R2 and Workers both stop at 100 MB.
export const MAX_BYTES = 100 * 1024 * 1024;
// Inline, base64 in the tool call itself.
export const MAX_INLINE = 4 * 1024 * 1024;
const OFFER_TTL = 3600;

export const MEDIA_ID = /^[0-9a-f]{12}$/;

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  m4a: "audio/mp4",
  flac: "audio/flac",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
};

export class MediaError extends Error {}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// The last part of a path, without control characters.
export function fileName(v: unknown): string {
  const name = String(v ?? "").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  if (!name || name === "." || name === "..") throw new MediaError("say what the file is called, like plot.png");
  return name;
}

export function fileType(name: string, given?: unknown): string {
  if (typeof given === "string" && given.trim()) {
    const t = given.trim().toLowerCase();
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(t)) throw new MediaError(`${given} isn't a MIME type, like image/png`);
    return t;
  }
  return TYPES[(name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase()] ?? "application/octet-stream";
}

export const mediaKey = (user: string, board: string, card: string, id = "") => `${user}/${board}/${card}/${id}`;

// The card's list, as extra keeps it.
export const mediaOf = (extra: Record<string, unknown>): Media[] => (Array.isArray(extra.media) ? (extra.media as Media[]) : []);

type Cards = {
  get(id: string): Promise<{ ok: true; value: { extra: Record<string, unknown>; version: number } } | { ok: false; status: number; error: string }>;
  update(id: string, f: object, version: number): Promise<{ ok: boolean; status?: number; error?: string; card?: unknown }>;
  appendLog(id: string, who: string, note: string): Promise<unknown>;
};

const cardsOf = (env: Env, user: string, board: string) => env.BOARD.get(env.BOARD.idFromName(`${user}/${board}`)) as unknown as Cards;

function size(bytes: number) {
  const units = ["B", "KB", "MB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return i ? `${bytes.toFixed(1)} ${units[i]}` : `${bytes} B`;
}

// The file on its card, newest last, and a line in its log.
async function record(env: Env, user: string, board: string, card: string, m: Media) {
  const cards = cardsOf(env, user, board);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await cards.get(card);
    if (!r.ok) throw new MediaError(r.error);
    const media = [...mediaOf(r.value.extra).filter((x) => x.id !== m.id), m];
    const w = await cards.update(card, { extra: { ...r.value.extra, media } }, r.value.version);
    if (w.ok) {
      await cards.appendLog(card, m.who, `attached ${m.name} (${m.type}, ${size(m.size)})`);
      return m;
    }
    // A 409 with the card is someone else's write since; any other is final.
    if (!(w.status === 409 && w.card)) throw new MediaError(w.error ?? "couldn't attach it");
  }
  throw new MediaError(`card ${card} is busy; try again`);
}

// Checked before any bytes are kept, so a bad card leaves nothing behind.
async function exists(env: Env, user: string, board: string, card: string) {
  const r = await cardsOf(env, user, board).get(card);
  if (!r.ok) throw new MediaError(r.error);
}

const newId = () => hex(crypto.getRandomValues(new Uint8Array(6)));

// A file in hand: kept and on the card at once.
export async function attach(env: Env, user: string, board: string, card: string, who: string, name: string, type: string, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BYTES) throw new MediaError(`files stop at ${size(MAX_BYTES)}`);
  await exists(env, user, board, card);
  const id = newId();
  await env.MEDIA.put(mediaKey(user, board, card, id), bytes, { httpMetadata: { contentType: type } });
  return record(env, user, board, card, { id, name, type, size: bytes.byteLength, at: now(), who });
}

type Offer = { user: string; board: string; card: string; who: string; name: string; type: string };

// An upload for later: the URL to PUT the file to.
export async function offer(env: Env, user: string, board: string, card: string, who: string, name: string, type: string) {
  await exists(env, user, board, card);
  const token = hex(crypto.getRandomValues(new Uint8Array(24)));
  const o: Offer = { user, board, card, who, name, type };
  await env.OAUTH_KV.put(`upload:${await sha256(token)}`, JSON.stringify(o), { expirationTtl: OFFER_TTL });
  return { url: `${env.ORIGIN}/upload/${token}`, expires_at: new Date(Date.now() + OFFER_TTL * 1000).toISOString() };
}

// PUT /upload/:token, from the agent's machine. The token is the auth, and
// it's good for one file.
export async function upload(request: Request, env: Env): Promise<Response> {
  const fail = (status: number, error: string) => Response.json({ error }, { status });
  if (request.method !== "PUT") return fail(405, "PUT the file here");
  const token = new URL(request.url).pathname.slice("/upload/".length);
  if (!/^[0-9a-f]{48}$/.test(token)) return fail(404, "no such upload");
  const key = `upload:${await sha256(token)}`;
  const o = await env.OAUTH_KV.get<Offer>(key, "json");
  if (!o) return fail(404, "no such upload, or it expired; ask attach_file for another");
  const length = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isInteger(length) || length <= 0) return fail(411, "send the file with its Content-Length (curl -T does)");
  if (length > MAX_BYTES) return fail(413, `files stop at ${size(MAX_BYTES)}`);
  await env.OAUTH_KV.delete(key);
  const id = newId();
  await env.MEDIA.put(mediaKey(o.user, o.board, o.card, id), request.body, { httpMetadata: { contentType: o.type } });
  try {
    return Response.json(await record(env, o.user, o.board, o.card, { id, name: o.name, type: o.type, size: length, at: now(), who: o.who }), { status: 201 });
  } catch (e) {
    await env.MEDIA.delete(mediaKey(o.user, o.board, o.card, id));
    if (e instanceof MediaError) return fail(409, e.message);
    throw e;
  }
}

// One file, as it was attached.
export async function serve(env: Env, user: string, board: string, card: string, id: string): Promise<Response> {
  const obj = await env.MEDIA.get(mediaKey(user, board, card, id));
  if (!obj) return Response.json({ error: `no file ${id} on ${card}` }, { status: 404 });
  const headers = new Headers({ "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

// Everything under a card or a board, when it's deleted for good.
export async function forget(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
