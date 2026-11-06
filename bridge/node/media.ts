// Files agents attach to cards (.agent/plans/local-boards.md, step 4), as
// the Worker's media.ts takes them, with the bytes sealed under the board's
// key. A file is cut into pieces of PIECE bytes, each sealed as a blob of
// its own (the relay keeps a blob of at most 25 MB, a file here is up to
// 100 MB), and its `media:<id>` record (data.ts's StoredMedia) names them
// in order, so a piece can't be swapped or moved without the record saying.
//
// Each sealed piece is kept on this machine too (<state>/node/blobs), so
// the page reads a file attached here without the relay; a node that
// didn't attach it gets the pieces from the relay and keeps them. An
// account only on this machine has no relay: its pieces are only here.
//
// attach_file (mcp.ts) takes a small file inline or offers an upload: a URL
// on the node, good once for an hour, that the agent PUTs the file to
// (curl -T). An offer is kept in memory on the node that made it, which is
// the one the agent's MCP calls reach.
//
//   PUT  /upload/:token                                     the file, as the body; no other auth
//   GET  /api/node/boards/:key/cards/:id/media/:mid         the file (server.ts)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBlob, sealBlob } from "../../lib/e2ee/record";
import { random } from "../../lib/e2ee/keys";
import { b64url } from "../../lib/e2ee/wire";
import { type Data, type MediaItem, type StoredMedia, Invalid, now } from "./data";
import type { Blobs } from "./handoff";

export const MAX_BYTES = 100 * 1024 * 1024;
// Inline, base64 in the tool call itself.
export const MAX_INLINE = 4 * 1024 * 1024;
// A piece, before it's sealed: under the relay's blob limit with room to spare.
export const PIECE = 16 * 1024 * 1024;
const OFFER_MS = 3600_000;

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

// The last part of a path, without control characters.
export function fileName(v: unknown): string {
  const name = String(v ?? "").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  if (!name || name === "." || name === "..") throw new Invalid("say what the file is called, like plot.png");
  return name;
}

export function fileType(name: string, given?: unknown): string {
  if (typeof given === "string" && given.trim()) {
    const t = given.trim().toLowerCase();
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(t)) throw new Invalid(`${given} isn't a MIME type, like image/png`);
    return t;
  }
  return TYPES[(name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase()] ?? "application/octet-stream";
}

export function size(bytes: number) {
  const units = ["B", "KB", "MB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return i ? `${bytes.toFixed(1)} ${units[i]}` : `${bytes} B`;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

type Offer = { board: string; card: string; who: string; name: string; type: string; until: number };

export class Media {
  private offers = new Map<string, Offer>();

  // blobs: the relay's, or none for an account only on this machine; dir:
  // where the sealed pieces are kept here.
  constructor(private o: { data: Data; blobs?: Blobs; dir: string }) {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }

  private key(board: string, epoch?: number) {
    const rep = this.o.data.replicas.get("board", board);
    if (!rep) throw new Invalid(`no board ${board} on this node`);
    const e = epoch ?? rep.currentEpoch;
    return rep.key(e).then((k) => {
      if (!k) throw new Error(`no key for board ${board} at epoch ${e}`);
      return { key: k, epoch: e };
    });
  }

  private local = (blob: string) => join(this.o.dir, blob);

  private async put(blob: string, sealed: Uint8Array) {
    writeFileSync(this.local(blob), sealed, { mode: 0o600 });
    await this.o.blobs?.putBlob(blob, sealed);
  }

  private async get(blob: string): Promise<Uint8Array> {
    try {
      return readFileSync(this.local(blob));
    } catch {}
    if (!this.o.blobs) throw new Error(`blob ${blob} isn't on this machine`);
    const sealed = await this.o.blobs.getBlob(blob);
    writeFileSync(this.local(blob), sealed, { mode: 0o600 });
    return sealed;
  }

  private async drop(blobs: string[]) {
    for (const b of blobs) {
      rmSync(this.local(b), { force: true });
      await this.o.blobs?.deleteBlob(b).catch((e: { status?: number; message: string }) => e.status === 404 || console.error(`media: deleting blob ${b}: ${e.message}`));
    }
  }

  // The bytes, as they come, in pieces sealed and kept one at a time; then
  // the file on its card. Pieces kept before a failure are let go of. as:
  // the file as the Worker had it, with its id and time, put on its card
  // with no line in the log (move.ts).
  private async keep(board: string, card: string, who: string, name: string, type: string, bytes: AsyncIterable<Uint8Array>, as?: { id: string; at: string }): Promise<MediaItem> {
    const { key, epoch } = await this.key(board);
    const blobs: string[] = [];
    let total = 0;
    try {
      const seal = async (piece: Uint8Array) => {
        const blob = b64url(random(18));
        await this.put(blob, sealBlob(key, blob, piece));
        blobs.push(blob);
      };
      let buf = new Uint8Array(PIECE);
      let at = 0;
      for await (const chunk of bytes) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new TooBig(`files stop at ${size(MAX_BYTES)}`);
        for (let off = 0; off < chunk.length; ) {
          const n = Math.min(PIECE - at, chunk.length - off);
          buf.set(chunk.subarray(off, off + n), at);
          (at += n), (off += n);
          if (at === PIECE) {
            await seal(buf);
            (buf = new Uint8Array(PIECE)), (at = 0);
          }
        }
      }
      if (at || !blobs.length) await seal(buf.subarray(0, at));
      const s: StoredMedia = { id: as?.id ?? hex(random(6)), card, name, type, size: total, at: as?.at ?? now(), who, blobs, epoch };
      return await this.o.data.addMedia(board, s, as ? null : `attached ${name} (${type}, ${size(total)})`);
    } catch (e) {
      await this.drop(blobs);
      throw e;
    }
  }

  // A file in hand: kept and on the card at once.
  async attach(board: string, card: string, who: string, name: string, type: string, bytes: Uint8Array): Promise<MediaItem> {
    if (bytes.byteLength > MAX_BYTES) throw new Invalid(`files stop at ${size(MAX_BYTES)}`);
    this.o.data.card(board, card);
    return this.keep(board, card, who, name, type, (async function* () {
      yield bytes;
    })());
  }

  // A file the Worker kept, by its id, time and who attached it. One the
  // board has by that id already is left as it is.
  async restore(board: string, m: MediaItem & { card: string }, bytes: AsyncIterable<Uint8Array>): Promise<MediaItem> {
    if (!MEDIA_ID.test(m.id)) throw new Invalid(`${m.id} isn't a file's id`);
    const had = this.o.data.media(board, m.card).find((s) => s.id === m.id);
    if (had) return { id: had.id, name: had.name, type: had.type, size: had.size, at: had.at, who: had.who };
    this.o.data.card(board, m.card);
    return this.keep(board, m.card, m.who, fileName(m.name), fileType(m.name, m.type), bytes, { id: m.id, at: m.at });
  }

  // An upload for later: the URL, at origin, to PUT the file to.
  offer(origin: string, board: string, card: string, who: string, name: string, type: string) {
    this.o.data.card(board, card);
    const t = Date.now();
    for (const [k, v] of this.offers) if (v.until < t) this.offers.delete(k);
    const token = hex(random(24));
    this.offers.set(sha256(token), { board, card, who, name, type, until: t + OFFER_MS });
    return { url: `${origin}/upload/${token}`, expires_at: new Date(t + OFFER_MS).toISOString() };
  }

  // PUT /upload/:token, from the agent's machine. The token is the auth, and
  // it's good for one file.
  async upload(req: Request, token: string): Promise<Response> {
    if (req.method !== "PUT") return fail(405, "PUT the file here");
    if (!/^[0-9a-f]{48}$/.test(token)) return fail(404, "no such upload");
    const k = sha256(token);
    const o = this.offers.get(k);
    if (!o || o.until < Date.now()) return fail(404, "no such upload, or it expired; ask attach_file for another");
    const length = Number(req.headers.get("content-length"));
    if (!req.body || !Number.isInteger(length) || length <= 0) return fail(411, "send the file with its Content-Length (curl -T does)");
    if (length > MAX_BYTES) return fail(413, `files stop at ${size(MAX_BYTES)}`);
    this.offers.delete(k);
    try {
      return Response.json(await this.keep(o.board, o.card, o.who, o.name, o.type, req.body), { status: 201 });
    } catch (e) {
      if (e instanceof TooBig) return fail(413, e.message);
      if (e instanceof Invalid) return fail(409, e.message);
      throw e;
    }
  }

  // One file, as it was attached, opened a piece at a time; undefined if
  // the board or the card doesn't have it.
  serve(board: string, card: string, id: string): Response | undefined {
    if (!MEDIA_ID.test(id) || !this.o.data.replicas.get("board", board)) return;
    const s = this.o.data.media(board, card).find((m) => m.id === id);
    if (!s) return;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: async (c) => {
        if (i === s.blobs.length) return c.close();
        const { key } = await this.key(board, s.epoch);
        const blob = s.blobs[i++];
        c.enqueue(openBlob(key, blob, await this.get(blob)));
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": s.type,
        "Content-Length": String(s.size),
        ETag: `"${s.id}"`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // A card's files, when it's deleted for good.
  async forget(board: string, card: string) {
    for (const s of await this.o.data.dropMedia(board, card)) await this.drop(s.blobs);
  }
}

class TooBig extends Error {}
