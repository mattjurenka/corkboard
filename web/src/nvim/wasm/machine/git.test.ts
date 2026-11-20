// `git` for a page with no machine (git.ts) against git itself: a repository
// made with git, copied into the page's files (vfs.ts) at the same path,
// and the commands corkboard's Lua runs put to both (util.git, the file
// browser and the worktrees in nvim/lua/corkboard). What it prints, and
// whether it failed, should be git's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGit } from "./git";
import { Vfs } from "./vfs";

const root = realpathSync(mkdtempSync(`${tmpdir()}/vfs-git-`));
const repo = `${root}/repo`;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdin: "ignore" });
  if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const write = (path: string, text: string) => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, text);
};

// The disk under dir, into vfs at the same paths.
function copy(vfs: Vfs, dir: string) {
  vfs.mkdirp(dir);
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    const s = lstatSync(p);
    if (s.isSymbolicLink()) vfs.op("symlink", [readlinkSync(p), p]);
    else if (s.isDirectory()) copy(vfs, p);
    else vfs.writeFile(p, new Uint8Array(readFileSync(p)), s.mode & 0o777);
  }
}

let vfs: Vfs;
beforeAll(() => {
  sh(root, "init", "-q", "-b", "main", repo);
  write(`${repo}/README.md`, "# r\n");
  write(`${repo}/src/a.ts`, "a\n");
  write(`${repo}/src/b.ts`, "b\n");
  write(`${repo}/gone.txt`, "gone\n");
  write(`${repo}/.gitignore`, "node_modules/\n*.log\n/build\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "First\n\nwith a body");
  write(`${repo}/src/a.ts`, "a2\n");
  sh(repo, "commit", "-q", "-am", "Second: a's changed");
  sh(repo, "remote", "add", "origin", "https://git.example/r.git");
  sh(repo, "config", "user.name", "Someone");
  // Changes of every kind since.
  write(`${repo}/src/a.ts`, "a3\n"); // modified, unstaged
  write(`${repo}/src/b.ts`, "b2\n");
  sh(repo, "add", "src/b.ts"); // modified, staged
  write(`${repo}/new.ts`, "new\n");
  sh(repo, "add", "new.ts"); // added
  unlinkSync(`${repo}/gone.txt`); // deleted, unstaged
  write(`${repo}/untracked.md`, "u\n");
  write(`${repo}/src/also.md`, "u\n");
  write(`${repo}/notes/a.md`, "u\n"); // a directory with nothing tracked
  write(`${repo}/notes/deep/b.md`, "u\n");
  write(`${repo}/src/lib/c.ts`, "u\n");
  write(`${repo}/debug.log`, "ignored\n");
  write(`${repo}/node_modules/x/index.js`, "ignored\n");
  write(`${repo}/build/out.js`, "ignored\n");
  vfs = new Vfs();
  copy(vfs, repo);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));


// What the page's git and git itself said differently, of each call: its
// args, cwd and stdin, and [succeeded, stdout] from each.
type Call = [args: string[], cwd?: string, stdin?: string];
async function differ(calls: Call[]) {
  const out: unknown[] = [];
  for (const [args, cwd = repo, stdin] of calls) {
    const input = stdin === undefined ? undefined : new TextEncoder().encode(stdin);
    const real = Bun.spawnSync(["git", ...args], { cwd, env, stdin: input ?? "ignore" });
    const page = await runGit(vfs, args, cwd, input);
    const git = [real.exitCode === 0, real.stdout.toString()];
    const ours = [page.code === 0, page.stdout];
    if (!Bun.deepEquals(ours, git)) out.push({ args, cwd: cwd.slice(repo.length) || ".", git, page: ours });
  }
  return out;
}

// The calls are nvim/lua/corkboard's, as it makes them.
describe("runGit as git", () => {
  test("rev-parse", async () => {
    expect(
      await differ([
        [["rev-parse", "HEAD"]],
        [["rev-parse", "--short", "HEAD"]],
        [["rev-parse", "--show-prefix"]],
        [["rev-parse", "--show-prefix"], `${repo}/src`],
        [["rev-parse", "--absolute-git-dir"]],
        [["rev-parse", "--absolute-git-dir"], `${repo}/src`],
        [["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]],
        [["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], `${repo}/src`],
        [["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], `${repo}/src`],
        [["rev-parse", "--verify", "--quiet", "refs/heads/main"]],
        [["rev-parse", "--verify", "--quiet", "refs/heads/nope"]],
      ]),
    ).toEqual([]);
  });

  test("outside a repository", async () => {
    mkdirSync(`${root}/elsewhere`, { recursive: true });
    vfs.mkdirp(`${root}/elsewhere`);
    const r = await runGit(vfs, ["rev-parse", "HEAD"], `${root}/elsewhere`);
    expect(r).toMatchObject({ code: 128, stdout: "" });
  });

  test("symbolic-ref", async () => {
    expect(
      await differ([
        [["symbolic-ref", "--short", "HEAD"]],
        [["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]],
        [["symbolic-ref", "HEAD"]],
      ]),
    ).toEqual([]);
    // With origin's HEAD, as a clone of all of it has.
    const head = `${repo}/.git/refs/remotes/origin/HEAD`;
    write(head, "ref: refs/remotes/origin/main\n");
    vfs.mkdirp(`${repo}/.git/refs/remotes/origin`);
    vfs.writeFile(head, new TextEncoder().encode("ref: refs/remotes/origin/main\n"));
    expect(await differ([[["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]], [["symbolic-ref", "refs/remotes/origin/HEAD"]]])).toEqual([]);
    unlinkSync(head);
    vfs.op("unlink", [head]);
  });

  test("status", async () => {
    expect(
      await differ([
        [["status", "--porcelain"]],
        [["status", "--porcelain", "--untracked-files=all"]],
        [["status", "--porcelain", "--untracked-files=no"]],
        [["status", "--porcelain", "-z", "--untracked-files=normal", "--", "."], `${repo}/src`],
        [["status", "--porcelain", "-z", "--untracked-files=normal", "--", "."]],
      ]),
    ).toEqual([]);
  });

  test("check-ignore", async () => {
    expect(
      await differ([
        [["check-ignore", "--stdin"], repo, "debug.log\nnode_modules\nbuild\nREADME.md\nsrc"],
        [["check-ignore", "--stdin"], repo, "README.md\nsrc"],
        [["check-ignore", "--stdin"], `${repo}/src`, "a.ts\nx.log"],
        [["check-ignore", "-q", "--", "debug.log"]],
        [["check-ignore", "-q", "--", "README.md"]],
      ]),
    ).toEqual([]);
  });

  test("log", async () => {
    expect(await differ([[["log", "--max-parents=0", "--format=%ct %H", "HEAD"]]])).toEqual([]);
  });

  test("config and remotes", async () => {
    expect(
      await differ([
        [["config", "--get-regexp", "^remote\\..*\\.url$"]],
        [["config", "--get", "corkboard.board"]],
        [["remote", "get-url", "origin"]],
        [["worktree", "list", "--porcelain"]],
      ]),
    ).toEqual([]);
    // Set, and read back by both.
    expect(await runGit(vfs, ["config", "corkboard.board", "b1"], repo)).toMatchObject({ code: 0 });
    expect(await runGit(vfs, ["config", "--get", "corkboard.board"], repo)).toMatchObject({ code: 0, stdout: "b1\n" });
    expect((await runGit(vfs, ["remote", "get-url", "nope"], repo)).code).toBe(2);
  });

  test("what it can't do fails, saying so", async () => {
    for (const args of [["push"], ["ls-files", "--cached"], ["rev-list", "--count", "HEAD"]]) {
      const r = await runGit(vfs, args, repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not in a page with no machine");
    }
  });
});
