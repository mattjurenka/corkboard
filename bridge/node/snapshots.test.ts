// The forge's state to the relay and back (snapshots.ts): two nodes' forge
// directories, one relay's blobs and one fleet object between them.
//   bun test bridge/node/snapshots.test.ts
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { random } from "../../lib/e2ee/keys";
import { DB_SNAPSHOT, ForgeSnapshots, repoSnapshot } from "./snapshots";
import type { Replicas } from "./replicas";

const root = mkdtempSync(join(tmpdir(), "forge-snapshots-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
};

// The relay and the fleet object, as both nodes see them.
const blobs = new Map<string, Uint8Array>();
const relay = {
  putBlob: async (id: string, b: Uint8Array) => void blobs.set(id, b.slice()),
  getBlob: async (id: string) => blobs.get(id) ?? Promise.reject(Object.assign(new Error("no such blob"), { status: 404 })),
  deleteBlob: async (id: string) => void blobs.delete(id),
};
const key = random(32);
const cards = new Map<string, Record<string, unknown>>();
let changes = 0;
const replicas = {
  get: () => ({ currentEpoch: 0, key: async () => key, cards: () => [...cards.entries()].map(([id, c]) => ({ id, ...c })) }),
  change: async (_k: string, _n: string, ...cs: { card: string; set: Record<string, unknown> }[]) => {
    for (const c of cs) cards.set(c.card, { ...cards.get(c.card), ...c.set }), changes++;
  },
} as unknown as Replicas;

function forge(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "repos", "matt"), { recursive: true });
  return { dir, snaps: new ForgeSnapshots({ dir, replicas, blobs: relay, dbEveryMs: 0 }) };
}

// A commit pushed to the forge's repo from a work tree.
function push(dir: string, repo: string, file: string) {
  const bare = join(dir, "repos", repo);
  if (!existsSync(bare)) git(dir, "init", "-q", "--bare", "-b", "main", bare);
  const work = mkdtempSync(join(root, "work-"));
  git(work, "init", "-q", "-b", "main");
  if (git(bare, "for-each-ref").length) git(work, "fetch", "-q", bare, "main"), git(work, "reset", "-q", "--hard", "FETCH_HEAD");
  writeFileSync(join(work, file), file);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", file);
  git(work, "push", "-q", bare, "main");
  rmSync(work, { recursive: true, force: true });
}

test("one node's repos, database and app.ini come back on another, and what it wrote itself isn't restored", async () => {
  const a = forge("a");
  push(a.dir, "matt/corkboard.git", "one");
  git(a.dir, "init", "-q", "--bare", join(a.dir, "repos", "matt", "empty.git"));
  git(join(a.dir, "repos", "matt", "corkboard.git"), "update-ref", "refs/tags/v1", "main");
  mkdirSync(join(a.dir, "data"));
  mkdirSync(join(a.dir, "custom", "conf"), { recursive: true });
  writeFileSync(join(a.dir, "custom", "conf", "app.ini"), "[security]\nSECRET_KEY = s\n");
  const db = new Database(join(a.dir, "data", "forgejo.db"));
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE repo (name TEXT)");
  db.run("INSERT INTO repo VALUES ('corkboard')");
  await a.snaps.step();
  expect([...cards.keys()].sort()).toEqual([DB_SNAPSHOT, repoSnapshot("matt/corkboard.git"), repoSnapshot("matt/empty.git")].sort());
  expect(await a.snaps.restore()).toBe(0);

  // Nothing changed: nothing written.
  const before = changes;
  await a.snaps.step();
  expect(changes).toBe(before);

  const b = forge("b");
  expect(await b.snaps.restore()).toBe(3);
  const repo = join(b.dir, "repos", "matt", "corkboard.git");
  expect(git(repo, "for-each-ref", "--format=%(objectname) %(refname)")).toBe(git(join(a.dir, "repos", "matt", "corkboard.git"), "for-each-ref", "--format=%(objectname) %(refname)"));
  expect(git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(repo, "config", "--bool", "core.bare")).toBe("true");
  expect(existsSync(join(b.dir, "repos", "matt", "empty.git", "HEAD"))).toBe(true);
  expect(new Database(join(b.dir, "data", "forgejo.db")).query("SELECT name FROM repo").all()).toEqual([{ name: "corkboard" }]);
  expect(readFileSync(join(b.dir, "custom", "conf", "app.ini"), "utf8")).toContain("SECRET_KEY = s");
  db.close();

  // b leads now: a push and a deleted repo, which a takes back.
  push(b.dir, "matt/corkboard.git", "two");
  rmSync(join(b.dir, "repos", "matt", "empty.git"), { recursive: true });
  const blobsBefore = new Set(blobs.keys());
  await b.snaps.step();
  expect([...blobsBefore].filter((id) => !blobs.has(id)).length).toBeGreaterThan(0);
  expect(await a.snaps.restore()).toBe(2);
  expect(git(join(a.dir, "repos", "matt", "corkboard.git"), "log", "--format=%s", "main")).toBe("two\none");
  expect(existsSync(join(a.dir, "repos", "matt", "empty.git"))).toBe(false);
});

test("a blob that can't be had stops the restore, so Forgejo isn't started on what's older", async () => {
  const c = forge("c");
  push(c.dir, "matt/lost.git", "x");
  await c.snaps.step();
  const rec = cards.get(repoSnapshot("matt/lost.git"))!;
  for (const id of rec.blobs as string[]) blobs.delete(id);
  const d = forge("d");
  await expect(d.snaps.restore()).rejects.toThrow();
});
