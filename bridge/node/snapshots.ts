// The forge's state follows the leader (.agent/plans/forge-on-leader.md,
// piece 5): the node running Forgejo writes it to the relay as blobs sealed
// with the fleet object's key, and a node about to start Forgejo restores
// what's newer than its own first. They're the backup too.
//
//   - each repo, as a `git bundle --all` when its refs have changed since the
//     last (looked at each step), so a push is kept within a minute;
//   - the database (`VACUUM INTO`, gzipped) when it has changed, at most
//     every dbEveryMs, with app.ini, whose secrets the database's are sealed
//     with. What came after the last dump is lost when the leader moves.
//
// One that's bigger than a blob goes up in parts. Its record in the fleet
// object says where, with a version this node also keeps in snapshots.json
// once its own state is that one; only a record with another version is
// restored, so a node never goes back to what it wrote itself:
//
//   snapshot:db              v, blobs, epoch, at, ini
//   snapshot:repo:<hash>     v, blobs, epoch, at, repo (owner/name), head,
//                            refs (their hash); gone: the repo was deleted
//
// Attachments, LFS objects and avatars (data/ besides the database) aren't
// kept.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { random } from "../../lib/e2ee/keys";
import { openBlob, sealBlob } from "../../lib/e2ee/record";
import { LIMITS, b64url } from "../../lib/e2ee/wire";
import type { Blobs } from "./handoff";
import { FLEET, SEP } from "./objects";
import type { Replicas } from "./replicas";

export const DB_SNAPSHOT = `snapshot${SEP}db`;
const REPO_PREFIX = `snapshot${SEP}repo${SEP}`;
export const repoSnapshot = (repo: string) => REPO_PREFIX + createHash("sha256").update(repo).digest("hex").slice(0, 32);
// A part's plaintext, under a blob with its nonce and tag.
const PART = LIMITS.blob - 1024 * 1024;

type Snap = { id: string; v?: string; blobs?: string[]; epoch?: number; at?: string; ini?: string; repo?: string; head?: string; refs?: string; gone?: boolean };

export type SnapshotConfig = {
  // The forge's directory (forgejo.ts's dir).
  dir: string;
  replicas: Replicas;
  blobs: Blobs;
  git?: string;
  dbEveryMs?: number;
};

export class ForgeSnapshots {
  private lastDb = 0;
  private busy: Promise<void> | undefined;

  constructor(private o: SnapshotConfig) {}

  private get rep() {
    const rep = this.o.replicas.get("fleet", FLEET);
    if (!rep) throw new Error("no fleet object on this node");
    return rep;
  }

  private records(): Snap[] {
    return this.rep.cards().filter((c) => !c.deleted && c.id.startsWith(`snapshot${SEP}`) && typeof c.v === "string") as unknown as Snap[];
  }

  // What this node's own state is, by record.
  private get localFile() {
    return join(this.o.dir, "snapshots.json");
  }
  private local(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.localFile, "utf8"));
    } catch {
      return {};
    }
  }
  private setLocal(id: string, v: string) {
    writeFileSync(this.localFile, JSON.stringify({ ...this.local(), [id]: v }) + "\n", { mode: 0o600 });
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const p = Bun.spawn([this.o.git ?? "git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if ((await p.exited) !== 0) throw new Error(`git ${args[0]}: ${err.trim().split("\n").pop()}`);
    return out;
  }

  // The bare repos under repos/, as owner/name (name with its .git).
  private repos(): string[] {
    const root = join(this.o.dir, "repos");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((o) => o.isDirectory())
      .flatMap((o) =>
        readdirSync(join(root, o.name), { withFileTypes: true })
          .filter((r) => r.isDirectory() && r.name.endsWith(".git"))
          .map((r) => `${o.name}/${r.name}`),
      );
  }

  private async refsOf(path: string) {
    const refs = await this.git(["for-each-ref", "--format=%(objectname) %(refname)"], path);
    const head = (await this.git(["symbolic-ref", "-q", "HEAD"], path).catch(() => "")).trim();
    return { refs: createHash("sha256").update(head + "\n" + refs).digest("hex"), head, empty: !refs.trim() };
  }

  private async put(bytes: Uint8Array): Promise<{ blobs: string[]; epoch: number }> {
    const epoch = this.rep.currentEpoch;
    const key = await this.rep.key(epoch);
    if (!key) throw new Error("no key for the fleet object");
    const blobs: string[] = [];
    for (let at = 0; at < bytes.length || !blobs.length; at += PART) {
      const id = b64url(random(18));
      await this.o.blobs.putBlob(id, sealBlob(key, id, bytes.subarray(at, at + PART)));
      blobs.push(id);
    }
    return { blobs, epoch };
  }

  private async get(s: Snap): Promise<Uint8Array> {
    const key = await this.rep.key(s.epoch ?? 0);
    if (!key) throw new Error(`no key for epoch ${s.epoch}`);
    const parts = await Promise.all((s.blobs ?? []).map(async (id) => openBlob(key, id, await this.o.blobs.getBlob(id))));
    return Buffer.concat(parts);
  }

  // A new version of a record, its old blobs then let go of.
  private async write(id: string, set: Omit<Snap, "id" | "v">) {
    const was = this.records().find((r) => r.id === id);
    const v = b64url(random(12));
    await this.o.replicas.change("fleet", FLEET, { t: "card", card: id, set: { at: new Date().toISOString(), ...set, v } });
    this.setLocal(id, v);
    for (const b of was?.blobs ?? []) await this.o.blobs.deleteBlob(b).catch((e) => console.error(`node: forge snapshot: deleting a blob: ${(e as Error).message}`));
  }

  // What's changed since the last, up to the relay. Only while this node's
  // Forgejo runs (and so holds the newest state); final, the last once it's
  // stopped, the database's whatever the time, after one under way.
  async step(now = Date.now(), final = false): Promise<void> {
    if (final) await this.busy;
    return (this.busy ??= this.snapshot(now, final)
      .catch((e) => console.error(`node: forge snapshot: ${(e as Error).message}`))
      .finally(() => (this.busy = undefined)));
  }

  private async snapshot(now: number, final: boolean) {
    const recs = new Map(this.records().map((r) => [r.id, r]));
    const local = this.local();
    const seen = new Set<string>();
    for (const repo of this.repos()) {
      const id = repoSnapshot(repo);
      seen.add(id);
      const path = join(this.o.dir, "repos", repo);
      const { refs, head, empty } = await this.refsOf(path);
      const rec = recs.get(id);
      if (rec && !rec.gone && rec.refs === refs && local[id] === rec.v) continue;
      let bytes = new Uint8Array();
      if (!empty) {
        const tmp = mkdtempSync(join(this.o.dir, ".bundle-"));
        try {
          await this.git(["bundle", "create", "-q", join(tmp, "b"), "--all"], path);
          bytes = readFileSync(join(tmp, "b"));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      await this.write(id, { ...(await this.put(bytes)), repo, head, refs, gone: false });
    }
    for (const rec of recs.values())
      if (rec.id.startsWith(REPO_PREFIX) && !rec.gone && !seen.has(rec.id)) await this.write(rec.id, { repo: rec.repo, blobs: [], gone: true });

    const db = join(this.o.dir, "data", "forgejo.db");
    if (!existsSync(db) || (!final && now - this.lastDb < (this.o.dbEveryMs ?? 15 * 60_000))) return;
    const changed = Math.max(...[db, `${db}-wal`].map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)));
    const dbRec = recs.get(DB_SNAPSHOT);
    if (dbRec && local[DB_SNAPSHOT] === dbRec.v && dbRec.at && Date.parse(dbRec.at) >= changed) return (void (this.lastDb = now));
    // Its time is the dump's start, so a write during it is a change next time.
    const at = new Date().toISOString();
    const tmp = mkdtempSync(join(this.o.dir, ".dump-"));
    try {
      const out = join(tmp, "forgejo.db");
      const conn = new Database(db);
      try {
        conn.run("PRAGMA busy_timeout = 10000");
        conn.run("VACUUM INTO ?", [out]);
      } finally {
        conn.close();
      }
      const ini = join(this.o.dir, "custom", "conf", "app.ini");
      await this.write(DB_SNAPSHOT, { at, ...(await this.put(Bun.gzipSync(readFileSync(out)))), ...(existsSync(ini) && { ini: readFileSync(ini, "utf8") }) });
      this.lastDb = now;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Before Forgejo starts: each piece another node wrote since this one's
  // state, put in place. Throws if any couldn't be, and Forgejo mustn't
  // start then, or it would write what's older over the relay's.
  async restore(): Promise<number> {
    await this.busy;
    const local = this.local();
    let n = 0;
    for (const rec of this.records()) {
      if (local[rec.id] === rec.v) continue;
      if (rec.id === DB_SNAPSHOT) {
        const bytes = Bun.gunzipSync(await this.get(rec) as Uint8Array<ArrayBuffer>);
        const data = join(this.o.dir, "data");
        mkdirSync(data, { recursive: true, mode: 0o700 });
        for (const f of ["forgejo.db-wal", "forgejo.db-shm"]) rmSync(join(data, f), { force: true });
        writeFileSync(join(data, ".forgejo.db.new"), bytes, { mode: 0o600 });
        renameSync(join(data, ".forgejo.db.new"), join(data, "forgejo.db"));
        // As old as the dump, so it isn't taken for a change and sent back up.
        if (rec.at) utimesSync(join(data, "forgejo.db"), new Date(rec.at), new Date(rec.at));
        if (rec.ini) {
          mkdirSync(join(this.o.dir, "custom", "conf"), { recursive: true, mode: 0o700 });
          writeFileSync(join(this.o.dir, "custom", "conf", "app.ini"), rec.ini, { mode: 0o600 });
        }
      } else if (rec.id.startsWith(REPO_PREFIX) && rec.repo && /^[\w.-]+\/[\w.-]+\.git$/.test(rec.repo) && !rec.repo.includes("..")) {
        const path = join(this.o.dir, "repos", rec.repo);
        if (rec.gone) rmSync(path, { recursive: true, force: true });
        else await this.restoreRepo(path, rec);
      } else continue;
      this.setLocal(rec.id, rec.v!);
      n++;
    }
    return n;
  }

  private async restoreRepo(path: string, rec: Snap) {
    const parent = join(path, "..");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(parent, ".restore-"));
    try {
      const repo = join(tmp, "repo.git");
      await this.git(["init", "-q", "--bare", repo]);
      const bytes = await this.get(rec);
      if (bytes.length) {
        writeFileSync(join(tmp, "b"), bytes);
        await this.git(["fetch", "-q", join(tmp, "b"), "+refs/*:refs/*"], repo);
      }
      if (rec.head) await this.git(["symbolic-ref", "HEAD", rec.head], repo);
      const old = existsSync(path) ? join(tmp, "old") : undefined;
      if (old) renameSync(path, old);
      renameSync(repo, path);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
