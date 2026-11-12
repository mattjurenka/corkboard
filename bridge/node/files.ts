// Files the user keeps on no card: sent from the phone, the page, or an
// agent, and kept on the leader alone (<state>/node/files there), as the
// forge is. Every other node passes a request for them on to the leader on
// its channel (serve.ts's toFiles), and a request that came on a channel is
// answered here, so two nodes that disagree on the leader don't pass one
// back and forth. Each file is its bytes (<id>) and what it is (<id>.json).
//
//   GET    /files               [{ id, name, type, size, at, who }], newest first
//   PUT    /files?name=&type=&who=   the file, as the body: { id, name, ... } (201)
//   GET    /files/:id           the file
//   DELETE /files/:id
//
// An agent's MCP calls (mcp.ts's list_files, read_file, keep_file) reach
// these on the node they're made to, which offers a URL there for one too
// big to pass in the call: good once for an hour, for curl.
//
//   PUT  /file-upload/:token   a file for keep_file; the token is the auth
//   GET  /file/:token          a file for read_file; the token is the auth

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { random } from "../../lib/e2ee/keys";
import { Invalid, now } from "./data";
import { MEDIA_ID, fileName, fileType, size } from "./media";

export const MAX_FILE = 1024 * 1024 * 1024;
const OFFER_MS = 3600_000;

export type FileItem = { id: string; name: string; type: string; size: number; at: string; who: string };

// A request to the leader's /files, wherever it is.
export type ToFiles = (path: string, init?: RequestInit) => Promise<Response>;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export class Files {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // What was being written when the node stopped.
    for (const f of readdirSync(dir)) if (f.endsWith(".part")) rmSync(join(dir, f), { force: true });
  }

  list(): FileItem[] {
    const out: FileItem[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")));
      } catch {}
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  get(id: string): FileItem | undefined {
    if (!MEDIA_ID.test(id)) return;
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8"));
    } catch {}
  }

  // The bytes as they come, to a .part that becomes the file once it's all here.
  async keep(name: string, type: string, who: string, body: ReadableStream<Uint8Array>): Promise<FileItem> {
    const id = hex(random(6));
    const part = join(this.dir, `${id}.part`);
    const out = createWriteStream(part, { mode: 0o600 });
    let total = 0;
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > MAX_FILE) throw new TooBig(`files stop at ${size(MAX_FILE)}`);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw e;
    }
    const f: FileItem = { id, name, type, size: total, at: now(), who };
    renameSync(part, join(this.dir, id));
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(f), { mode: 0o600 });
    return f;
  }

  drop(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.dir, id), { force: true });
    return true;
  }

  // /files/..., path after it.
  async serve(req: Request, path: string[]): Promise<Response> {
    const [id, more] = path;
    if (more) return fail(404, "not found");
    if (!id) {
      if (req.method === "GET") return json(this.list());
      if (req.method !== "PUT") return fail(405, "GET the list, or PUT a file");
      if (!req.body) return fail(400, "send the file as the body");
      const q = new URL(req.url).searchParams;
      const name = fileName(q.get("name"));
      try {
        return json(await this.keep(name, fileType(name, q.get("type") ?? undefined), (q.get("who") || "you").slice(0, 64), req.body), 201);
      } catch (e) {
        if (e instanceof TooBig) return fail(413, e.message);
        throw e;
      }
    }
    const f = this.get(id);
    if (!f) return fail(404, `no file ${id}`);
    if (req.method === "DELETE") return this.drop(id), json({});
    if (req.method !== "GET") return fail(405, "GET or DELETE a file");
    return new Response(Bun.file(join(this.dir, id)).stream(), {
      headers: {
        "Content-Type": f.type,
        "Content-Length": String(f.size),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        ETag: `"${f.id}"`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}

class TooBig extends Error {}

type Offer = { kind: "up"; name: string; type: string; who: string; until: number } | { kind: "down"; id: string; until: number };

// The URLs keep_file and read_file hand out, kept in memory on the node
// that made them, the one the agent's MCP calls reach.
export class FileOffers {
  private offers = new Map<string, Offer>();

  constructor(private to: ToFiles) {}

  private offer(o: Offer, origin: string, path: string) {
    const t = Date.now();
    for (const [k, v] of this.offers) if (v.until < t) this.offers.delete(k);
    const token = hex(random(24));
    this.offers.set(sha256(token), o);
    return { url: `${origin}/${path}/${token}`, expires_at: new Date(o.until).toISOString() };
  }

  upload(origin: string, name: string, type: string, who: string) {
    return this.offer({ kind: "up", name, type, who, until: Date.now() + OFFER_MS }, origin, "file-upload");
  }

  download(origin: string, id: string) {
    return this.offer({ kind: "down", id, until: Date.now() + OFFER_MS }, origin, "file");
  }

  private take(token: string, kind: Offer["kind"]) {
    if (!/^[0-9a-f]{48}$/.test(token)) return;
    const k = sha256(token);
    const o = this.offers.get(k);
    if (!o || o.kind !== kind || o.until < Date.now()) return;
    // An upload is good once; a download for its hour.
    if (kind === "up") this.offers.delete(k);
    return o;
  }

  // PUT /file-upload/:token
  async put(req: Request, token: string): Promise<Response> {
    if (req.method !== "PUT") return fail(405, "PUT the file here");
    const o = this.take(token, "up");
    if (!o || o.kind !== "up") return fail(404, "no such upload, or it expired; ask keep_file for another");
    if (!req.body) return fail(411, "send the file as the body (curl -T does)");
    const q = new URLSearchParams({ name: o.name, type: o.type, who: o.who });
    return this.to(`/files?${q}`, { method: "PUT", body: req.body });
  }

  // GET /file/:token
  async get(req: Request, token: string): Promise<Response> {
    if (req.method !== "GET") return fail(405, "GET the file here");
    const o = this.take(token, "down");
    if (!o || o.kind !== "down") return fail(404, "no such file, or the link expired; ask read_file for another");
    return this.to(`/files/${o.id}`, { signal: req.signal });
  }
}

// The leader's files, by MCP, from any node.
export async function filesJson<T>(to: ToFiles, path: string, init?: RequestInit): Promise<T> {
  const res = await to(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Invalid(body.error ?? `the leader answered ${res.status}`);
  return body as T;
}
