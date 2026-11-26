// forge-git.ts against real git: a home and a state of the test's own, and a
// forge that is bare repositories behind git http-backend
// (nvim/forge-server.ts) with the two things the bridge's /forge/ adds in
// front of it: a token git has to give, and the little of the API adopt asks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE, adopt, canonical, canonicalize, configText, forgeRepo, forgeUrl, install, keep } from "./forge-git";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "forge-git-")));
const home = join(dir, "home");
const state = join(dir, "state");
const bare = join(dir, "forge");
const TOKEN = "s3cret";
const was = { ...process.env };

let backend: ReturnType<typeof Bun.spawn>;
let server: ReturnType<typeof Bun.serve>;
let base = "";
// What reached /forge/ with no token, or the wrong one.
let refused = 0;

// git as the user's terminal runs it: their home's config, none of the bridge's.
function sh(args: string[], cwd = dir): string {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_CONFIG_")) delete env[k];
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
// The same, where the forge has to answer meanwhile: it's in this process.
async function net(args: string[], cwd = dir, env: Record<string, string> = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const e: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GIT_CONFIG_")) delete e[k];
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...e, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

const toForge = (path: string, init: RequestInit = {}) => fetch(`${base.replace(/\/$/, "")}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-corkboard-token": TOKEN } });
const forgeGit = () => ({ file: join(state, "gitconfig"), base, token: TOKEN, home });

// A repository with a commit on main, and what was asked besides.
function repo(name: string, o: { origin?: string } = {}): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  sh(["init", "--quiet", "--initial-branch=main"], root);
  writeFileSync(join(root, "README.md"), `${name}\n`);
  sh(["add", "."], root);
  sh(["commit", "--quiet", "-m", "first"], root);
  if (o.origin) sh(["remote", "add", "origin", o.origin], root);
  return root;
}
function commit(root: string, file: string) {
  writeFileSync(join(root, file), `${file}\n`);
  sh(["add", "."], root);
  sh(["commit", "--quiet", "-m", file], root);
}
const refsOf = (path: string) => sh(["for-each-ref", "--format=%(refname) %(objectname)"], path).split("\n").sort();

beforeAll(async () => {
  for (const d of [home, state, bare]) mkdirSync(d, { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_") && k !== "GIT_CONFIG_NOSYSTEM") delete process.env[k];
  const portFile = join(dir, "backend.port");
  backend = Bun.spawn(["bun", join(import.meta.dir, "../nvim/forge-server.ts"), bare, portFile], { stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 500 && !existsSync(portFile); i++) await Bun.sleep(10);
  const port = readFileSync(portFile, "utf8");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/forge/")) return new Response("a bridge");
      if (req.headers.get("x-corkboard-token") !== TOKEN) {
        refused++;
        return new Response("wrong token", { status: 401, headers: { "www-authenticate": 'Basic realm="corkboard"' } });
      }
      const path = url.pathname.slice("/forge".length);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (path === "/api/v1/user") return json({ login: "me" });
      if (path === "/api/v1/user/repos" && req.method === "POST") {
        const { name } = (await req.json()) as { name: string };
        Bun.spawnSync(["git", "init", "--quiet", "--bare", "--initial-branch=main", join(bare, "me", `${name}.git`)]);
        return json({ full_name: `me/${name}` }, 201);
      }
      const named = path.match(/^\/api\/v1\/repos\/(me\/[\w.-]+)$/);
      if (named) return existsSync(join(bare, `${named[1]}.git`)) ? json({ full_name: named[1] }) : json({ message: "not found" }, 404);
      const headers = new Headers();
      for (const h of ["content-type", "accept", "git-protocol"]) if (req.headers.has(h)) headers.set(h, req.headers.get(h)!);
      const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
      // Bun's fetch unpacks what git packed; http-backend is told neither.
      const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: req.method, headers, body });
      return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" } });
    },
  });
  base = `http://127.0.0.1:${server.port}/forge/`;
});

afterAll(() => {
  server?.stop(true);
  backend?.kill();
  for (const k of Object.keys(process.env)) if (!(k in was)) delete process.env[k];
  Object.assign(process.env, was);
  rmSync(dir, { recursive: true, force: true });
});

describe("a forge remote, however it's written", () => {
  test("a bridge's loopback /forge/ is the forge's, whatever its port; nothing else is", () => {
    expect(canonical("http://127.0.0.1:7777/forge/me/project.git")).toBe("corkboard://forge/me/project.git");
    expect(canonical("http://localhost:7778/forge/me/project.git\n")).toBe("corkboard://forge/me/project.git");
    expect(canonical("http://[::1]:9/forge/me/project.git")).toBe("corkboard://forge/me/project.git");
    expect(canonical("https://github.com/me/project.git")).toBeUndefined();
    expect(canonical("http://192.168.1.4:7777/forge/me/project.git")).toBeUndefined();
    expect(canonical("corkboard://forge/me/project.git")).toBeUndefined();
  });

  test("owner/repo of either, and the remote of an owner/repo", () => {
    expect(forgeRepo("corkboard://forge/me/project.git")).toBe("me/project");
    expect(forgeRepo("http://127.0.0.1:7777/forge/me/project.git")).toBe("me/project");
    expect(forgeRepo("corkboard://forge/me/project")).toBe("me/project");
    expect(forgeRepo("corkboard://forge/api/v1/user/repos")).toBeUndefined();
    expect(forgeRepo("https://github.com/me/project.git")).toBeUndefined();
    expect(forgeUrl("me/project")).toBe("corkboard://forge/me/project.git");
    expect(forgeUrl("me/project.git")).toBe("corkboard://forge/me/project.git");
  });

  test("the file: the rewrite, and the token only when there is one", () => {
    expect(configText({ base: "http://127.0.0.1:1/forge/", token: "" })).not.toContain("extraHeader");
    expect(configText({ base: "http://127.0.0.1:1/forge/", token: "t" })).toContain("\textraHeader = x-corkboard-token: t\n");
  });
});

describe("install", () => {
  test("left alone when asked: the file and the bridge's own env, and no git config of the user's", async () => {
    const got = await install({ ...forgeGit(), global: false });
    expect(got.global).toBe(false);
    expect(existsSync(join(home, ".gitconfig"))).toBe(false);
    expect(readFileSync(join(state, "gitconfig"), "utf8")).toBe(configText({ base, token: TOKEN }));
    expect((await net(["ls-remote", "--get-url", `${FORGE}a/b.git`], dir, got.env)).out).toBe(`${base}a/b.git`);
    expect(sh(["ls-remote", "--get-url", `${FORGE}a/b.git`])).toBe(`${FORGE}a/b.git`);
  });

  test("the user's git config includes the file, once however often it starts", async () => {
    expect((await install(forgeGit())).global).toBe(true);
    expect((await install(forgeGit())).global).toBe(true);
    expect(sh(["config", "--global", "--get-all", "include.path"]).split("\n")).toEqual([join(state, "gitconfig")]);
    expect(sh(["ls-remote", "--get-url", `${FORGE}a/b.git`])).toBe(`${base}a/b.git`);
  });

  test("another start's port is followed with nothing more written", async () => {
    const before = readFileSync(join(home, ".gitconfig"), "utf8");
    expect((await install({ ...forgeGit(), base: "http://127.0.0.1:1/forge/" })).global).toBe(true);
    expect(sh(["ls-remote", "--get-url", `${FORGE}a/b.git`])).toBe("http://127.0.0.1:1/forge/a/b.git");
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(before);
    await install(forgeGit());
  });

  test("a git config that can't be written (home-manager's): ~/.gitconfig gets it", async () => {
    const other = join(dir, "home2");
    const xdg = join(other, ".config/git");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, "config"), "[user]\n\tname = t\n");
    chmodSync(join(xdg, "config"), 0o444);
    chmodSync(xdg, 0o555);
    try {
      const o = { ...forgeGit(), file: join(dir, "state2/gitconfig"), home: other };
      expect((await install(o)).global).toBe(true);
      expect(readFileSync(join(other, ".gitconfig"), "utf8")).toContain(o.file);
      expect(readFileSync(join(xdg, "config"), "utf8")).toBe("[user]\n\tname = t\n");
    } finally {
      chmodSync(xdg, 0o755);
      await install(forgeGit());
    }
  });
});

describe("keep", () => {
  test("the file is taken back from a bridge that's gone, and left to one that answers", async () => {
    const o = forgeGit();
    const stop = keep(o, 20);
    try {
      writeFileSync(o.file, configText({ base: "http://127.0.0.1:1/forge/", token: "" }));
      for (let i = 0; i < 200 && readFileSync(o.file, "utf8") !== configText(o); i++) await Bun.sleep(20);
      expect(readFileSync(o.file, "utf8")).toBe(configText(o));

      const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("wrong token", { status: 401 }) });
      const theirs = configText({ base: `http://127.0.0.1:${other.port}/forge/`, token: "x" });
      writeFileSync(o.file, theirs);
      await Bun.sleep(200);
      expect(readFileSync(o.file, "utf8")).toBe(theirs);
      other.stop(true);
      for (let i = 0; i < 200 && readFileSync(o.file, "utf8") !== configText(o); i++) await Bun.sleep(20);
      expect(readFileSync(o.file, "utf8")).toBe(configText(o));
    } finally {
      stop();
    }
  });
});

describe("canonicalize", () => {
  test("a clone's loopback forge remotes name the forge; its others are as they were", async () => {
    const root = repo("legacy", { origin: "http://127.0.0.1:7777/forge/me/legacy.git" });
    sh(["remote", "add", "github", "https://github.com/me/legacy.git"], root);
    sh(["remote", "add", "dev", "http://localhost:7779/forge/me/legacy.git"], root);
    sh(["config", "remote.dev.pushurl", "http://127.0.0.1:7779/forge/me/legacy.git"], root);
    expect((await canonicalize(root)).sort()).toEqual(["dev", "origin"]);
    expect(sh(["config", "--get-regexp", "^remote\\..*url$"], root).split("\n").sort()).toEqual([
      "remote.dev.pushurl corkboard://forge/me/legacy.git",
      "remote.dev.url corkboard://forge/me/legacy.git",
      "remote.github.url https://github.com/me/legacy.git",
      "remote.origin.url corkboard://forge/me/legacy.git",
    ]);
    expect(await canonicalize(root)).toEqual([]);
    expect(await canonicalize(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("adopt", () => {
  test("a clone of somewhere else: everything goes to a new repository on the forge, which is origin after", async () => {
    // GitHub, as far as git here can tell.
    const github = join(dir, "github/me/moving.git");
    sh(["init", "--quiet", "--bare", "--initial-branch=main", github]);
    sh(["config", "--global", `url.file://${join(dir, "github")}/.insteadOf`, "https://github.com/"]);
    const root = repo("moving", { origin: "https://github.com/me/moving.git" });
    sh(["tag", "v1"], root);
    sh(["push", "--quiet", "-u", "origin", "main", "v1"], root);
    // One branch only GitHub has, one only here, and main ahead here.
    sh(["checkout", "--quiet", "-b", "theirs"], root);
    commit(root, "theirs.txt");
    sh(["push", "--quiet", "origin", "theirs"], root);
    sh(["checkout", "--quiet", "main"], root);
    sh(["branch", "--quiet", "-D", "theirs"], root);
    sh(["checkout", "--quiet", "-b", "mine"], root);
    commit(root, "mine.txt");
    sh(["checkout", "--quiet", "main"], root);
    commit(root, "ahead.txt");
    refused = 0;

    const got = await adopt(root, toForge);
    expect(got).toEqual({ repo: "me/moving", url: "corkboard://forge/me/moving.git", created: true, already: false, branches: 3, kept: "github", notes: [] });
    expect(refused).toBe(0);
    expect(sh(["config", "--get", "remote.origin.url"], root)).toBe("corkboard://forge/me/moving.git");
    expect(sh(["config", "--get", "remote.github.url"], root)).toBe("https://github.com/me/moving.git");
    expect(sh(["rev-parse", "--abbrev-ref", "main@{upstream}", "mine@{upstream}"], root)).toBe("origin/main\norigin/mine");
    const there = refsOf(join(bare, "me/moving.git"));
    expect(there.map((l) => l.split(" ")[0])).toEqual(["refs/heads/main", "refs/heads/mine", "refs/heads/theirs", "refs/tags/v1"]);
    expect(there).toContain(`refs/heads/main ${sh(["rev-parse", "main"], root)}`);
    expect(there).toContain(`refs/heads/theirs ${sh(["rev-parse", "github/theirs"], root)}`);

    // And again: nothing to do.
    expect(await adopt(root, toForge)).toMatchObject({ repo: "me/moving", already: true, created: false });

    // git in a terminal, with nothing but the user's git config: the token
    // goes with the rewritten address, both ways.
    commit(root, "later.txt");
    const pushed = await net(["push", "--quiet"], root);
    expect(pushed).toMatchObject({ ok: true });
    expect(refsOf(join(bare, "me/moving.git"))).toContain(`refs/heads/main ${sh(["rev-parse", "main"], root)}`);
    const clone = await net(["clone", "--quiet", "corkboard://forge/me/moving.git", join(dir, "moving-again")]);
    expect(clone).toMatchObject({ ok: true });
    expect(sh(["config", "--get", "remote.origin.url"], join(dir, "moving-again"))).toBe("corkboard://forge/me/moving.git");
    expect(refused).toBe(0);
    // Without it, the forge is closed.
    expect((await net(["ls-remote", `${base}me/moving.git`], dir, { GIT_CONFIG_GLOBAL: "/dev/null" })).ok).toBe(false);
    expect(refused).toBeGreaterThan(0);
  });

  test("a repository with no remote, under a name asked for", async () => {
    const root = repo("local only");
    const got = await adopt(root, toForge, { name: "kept-here" });
    expect(got).toMatchObject({ repo: "me/kept-here", created: true, branches: 1, kept: null, notes: [] });
    expect(sh(["rev-parse", "--abbrev-ref", "main@{upstream}"], root)).toBe("origin/main");
    expect(refsOf(join(bare, "me/kept-here.git"))).toEqual([`refs/heads/main ${sh(["rev-parse", "main"], root)}`]);
  });

  test("by the directory's name, made one a repository can have", async () => {
    const root = repo("my project!");
    expect(await adopt(root, toForge)).toMatchObject({ repo: "me/my-project-" });
    expect(adopt(repo("other"), toForge, { name: "a/b" })).rejects.toThrow("isn't a name");
  });

  test("a legacy forge origin is the forge's already, and is written so", async () => {
    const root = repo("old", { origin: "http://127.0.0.1:7777/forge/me/old.git" });
    expect(await adopt(root, toForge)).toMatchObject({ repo: "me/old", already: true });
    expect(sh(["config", "--get", "remote.origin.url"], root)).toBe("corkboard://forge/me/old.git");
  });

  test("a repository there already with another history is never overwritten, and the clone is as it was", async () => {
    const theirs = repo("taken-src");
    commit(theirs, "theirs.txt");
    await adopt(theirs, toForge, { name: "taken" });
    const before = refsOf(join(bare, "me/taken.git"));

    const github = join(dir, "github/me/taken.git");
    sh(["init", "--quiet", "--bare", "--initial-branch=main", github]);
    const root = repo("taken", { origin: "https://github.com/me/taken.git" });
    sh(["push", "--quiet", "-u", "origin", "main"], root);
    expect(adopt(root, toForge)).rejects.toThrow("there already, and the push didn't go through, so origin is as it was");
    expect(refsOf(join(bare, "me/taken.git"))).toEqual(before);
    expect(sh(["remote"], root)).toBe("origin");
    expect(sh(["config", "--get", "remote.origin.url"], root)).toBe("https://github.com/me/taken.git");
  });

  test("not a repository, or one with nothing in it", async () => {
    expect(adopt(join(dir, "state"), toForge)).rejects.toThrow("isn't a git repository");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    sh(["init", "--quiet"], empty);
    expect(adopt(empty, toForge)).rejects.toThrow("has no commits");
  });
});
