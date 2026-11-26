// git on this machine and the account's forge (server.ts's /forge/, on the
// node's channel to the leader). A clone's remote is written
//
//   corkboard://forge/<owner>/<repo>.git
//
// which names no port and no machine, so it is the same in every clone, on
// every machine of the account, and in a board's remotes. git is told what it
// means here by a config file of the bridge's, <state>/gitconfig, written at
// each start:
//
//   [url "http://127.0.0.1:<port>/forge/"]    insteadOf = corkboard://forge/
//   [http "http://127.0.0.1:<port>/forge/"]   extraHeader = x-corkboard-token: <token>
//
// and included from the user's own git config (once: include.path), so git
// run anywhere on the machine reaches the forge with nothing to type, and
// from GIT_CONFIG_* in what the bridge starts, for a machine whose git config
// can't be written. The token is the forge's alone (server.ts's FORGE_TOKEN),
// not the page's.
//
// Before this, a remote was the loopback address itself, with the port of
// whichever bridge made it (the installed one's, the dev one's, the app's
// pick), so it broke under any other; canonicalize() rewrites those.
//
// Several bridges on a machine (installed, dev) share the file: the last one
// started has it, and each takes it back when the one that has it is gone
// (keep).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ToForge } from "./node/git";

export const FORGE = "corkboard://forge/";
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/forge\/(.+)$/;
const NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/;

// owner/repo's remote.
export const forgeUrl = (repo: string) => `${FORGE}${repo.replace(/\.git$/, "")}.git`;

// A remote written as a bridge's loopback /forge/, as it should be; or undefined.
export function canonical(url: string): string | undefined {
  const m = LOOPBACK.exec(url.trim());
  return m ? FORGE + m[1] : undefined;
}

// owner/repo, of a remote that is the forge's (either way it's written).
export function forgeRepo(url: string): string | undefined {
  const u = canonical(url) ?? url.trim();
  if (!u.startsWith(FORGE)) return;
  const repo = u.slice(FORGE.length).replace(/\/$/, "").replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined;
}

export type GitConfig = {
  // <state>/gitconfig.
  file: string;
  // This bridge's /forge/, e.g. http://127.0.0.1:7778/forge/.
  base: string;
  // What /forge/ wants in x-corkboard-token, or "" when it wants nothing.
  token: string;
  // The user's home, for its .gitconfig; a test's own.
  home?: string;
  // false: the user's git config is left alone (CORKBOARD_GIT_CONFIG=0, for
  // a bridge that isn't the user's: a test's, with a state of its own).
  global?: boolean;
};

export function configText(o: Pick<GitConfig, "base" | "token">): string {
  return [
    "# corkboard's (bridge/forge-git.ts), written again at each start: an edit here is lost.",
    `[url "${o.base}"]`,
    `\tinsteadOf = ${FORGE}`,
    ...(o.token ? [`[http "${o.base}"]`, `\textraHeader = x-corkboard-token: ${o.token}`] : []),
    "",
  ].join("\n");
}

// What the bridge's own git runs with (install's env), so they work where
// the user's git config couldn't be written.
let own: Record<string, string> = {};

type Ran = { ok: boolean; out: string; err: string };
async function git(args: string[], o: { cwd?: string; env?: Record<string, string | undefined>; ms?: number } = {}): Promise<Ran> {
  const p = Bun.spawn(["git", ...args], { cwd: o.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...(o.env ?? { ...process.env, ...own }), GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), o.ms ?? 30_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer));
  return { ok: code === 0, out: out.trim(), err: err.trim() || `git ${args[0]}: exit ${code}` };
}

// git as the user's own terminal has it: none of the bridge's GIT_CONFIG_*.
function outside(home?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  if (home) Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") });
  return env;
}

function write(o: GitConfig) {
  mkdirSync(dirname(o.file), { recursive: true });
  const tmp = `${o.file}.${process.pid}`;
  writeFileSync(tmp, configText(o), { mode: 0o600 });
  renameSync(tmp, o.file);
}

// Writes the file and has the user's git config include it. env: what the
// bridge's children get, which includes it too. global: whether git outside
// the bridge follows it; when not, why is logged, and remotes are left as
// they are.
export async function install(o: GitConfig): Promise<{ env: Record<string, string>; global: boolean }> {
  write(o);
  // git reads a path's backslashes as escapes.
  const path = o.file.replaceAll("\\", "/");
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env = { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "include.path", [`GIT_CONFIG_VALUE_${n}`]: path };
  own = env;
  if (o.global === false) return { env, global: false };
  const from = outside(o.home);
  const cwd = dirname(o.file);
  const probe = `${FORGE}a/b.git`;
  const follows = async () => (await git(["ls-remote", "--get-url", probe], { cwd, env: from })).out === `${o.base}a/b.git`;
  if (await follows()) return { env, global: true };
  // The user's config, wherever git keeps it; then ~/.gitconfig itself, which
  // git reads as well when the other is one it can't write (home-manager's).
  const ways = [["config", "--global"], ["config", "--file", join(o.home ?? homedir(), ".gitconfig")]];
  let why = "";
  for (const way of ways) {
    const has = await git([...way, "--get-all", "include.path"], { cwd, env: from });
    if (has.ok && has.out.split("\n").includes(path)) continue;
    const added = await git([...way, "--add", "include.path", path], { cwd, env: from });
    if (!added.ok) why = added.err;
    else if (await follows()) return { env, global: true };
  }
  console.error(`forge: git outside corkboard doesn't follow ${o.file}${why ? ` (${why})` : ""}; add it to your git config: [include] path = ${path}`);
  return { env, global: false };
}

// Takes the file back when the bridge it names is gone. Gives the way to stop.
export function keep(o: GitConfig, ms = 30_000): () => void {
  const mine = configText(o);
  const check = async () => {
    let text = "";
    try {
      text = readFileSync(o.file, "utf8");
    } catch {}
    if (text === mine) return;
    const base = /^\[url "(.+)"\]$/m.exec(text)?.[1];
    // Any answer, a refusal too, is a bridge there.
    if (base && base !== o.base && (await fetch(base, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false))) return;
    write(o);
  };
  const timer = setInterval(() => void check().catch(() => {}), ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A clone's remotes that are a bridge's loopback /forge/, written as the
// forge's. Gives the remotes changed.
export async function canonicalize(root: string): Promise<string[]> {
  if (!existsSync(join(root, ".git"))) return [];
  const got = await git(["config", "--local", "--get-regexp", "^remote\\..*\\.(push)?url$"], { cwd: root });
  if (!got.ok) return [];
  const changed: string[] = [];
  for (const line of got.out.split("\n")) {
    const m = line.match(/^(remote\.(.+)\.(?:push)?url) (\S+)$/);
    const to = m && canonical(m[3]);
    if (m && to && (await git(["config", "--local", m[1], to], { cwd: root })).ok) changed.push(m[2]);
  }
  return [...new Set(changed)];
}

export type Adopted = {
  // owner/repo on the forge, and the clone's origin now.
  repo: string;
  url: string;
  // Made by this call, rather than there already.
  created: boolean;
  // Origin was the forge's before the call: nothing was done.
  already: boolean;
  branches: number;
  // What the remote that was origin is called now.
  kept: string | null;
  // What it couldn't do, or did another way, one line each.
  notes: string[];
};

// The name a remote that was origin gets: its host's, when that's a name.
function oldName(url: string, taken: Set<string>): string {
  const host = /^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(url)?.[1]?.toLowerCase() ?? "";
  const by = host.match(/^(?:www\.)?(github|gitlab|bitbucket|codeberg)\./)?.[1];
  for (const name of [by, "upstream", "old-origin"]) if (name && !taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`old-origin-${i}`)) return `old-origin-${i}`;
}

// Puts the clone at dir on the account's forge and makes that its origin:
// a private repository of the user's (made if it isn't there), every branch
// and tag pushed, origin's branches that have no local one too, and the
// remote that was origin kept under another name. Nothing is forced: a
// repository there already with other history refuses the push, and the
// clone is left as it was.
export async function adopt(dir: string, forge: ToForge, o: { name?: string } = {}): Promise<Adopted> {
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: dir });
  if (!top.ok) throw new Error(`${dir} isn't a git repository`);
  const root = top.out;
  if (!(await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root })).ok) throw new Error(`${root} has no commits to put there`);
  await canonicalize(root);
  const remotes = new Map<string, string>();
  for (const line of (await git(["config", "--local", "--get-regexp", "^remote\\..*\\.url$"], { cwd: root })).out.split("\n")) {
    const m = line.match(/^remote\.(.+)\.url (\S+)$/);
    if (m) remotes.set(m[1], m[2]);
  }
  const origin = remotes.get("origin");
  const there = origin && forgeRepo(origin);
  if (there) return { repo: there, url: origin, created: false, already: true, branches: 0, kept: null, notes: [] };

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await forge(`/api/v1${path}`, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
    const body = (await res.json().catch(() => null)) as any;
    return { status: res.status, ok: res.ok, body, error: body?.message ?? body?.error ?? `HTTP ${res.status}` };
  };
  const me = await api("/user");
  if (!me.ok || !me.body?.login) throw new Error(`the forge: ${me.error}`);
  const name = o.name?.trim() || basename(root).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "");
  if (!NAME.test(name)) throw new Error(`${name || "that"} isn't a name a repository can have`);
  const repo = `${me.body.login}/${name}`;
  const url = forgeUrl(repo);
  const notes: string[] = [];

  // What origin has now, where it can be asked.
  if (origin && !(await git(["fetch", "--quiet", "--prune", "origin"], { cwd: root, ms: 5 * 60_000 })).ok) notes.push(`couldn't fetch from ${origin}, so its branches are as they were last fetched`);
  const refs = (await git(["for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/heads", "refs/remotes/origin"], { cwd: root })).out.split("\n").map((l) => l.split(" "));
  // Each branch at origin's commit, or the local one when that's ahead of it or has gone its own way.
  const want = new Map<string, string>();
  for (const [ref, sha, sym] of refs) if (ref?.startsWith("refs/remotes/origin/") && !sym) want.set(ref.slice("refs/remotes/origin/".length), sha);
  for (const [ref, sha] of refs) {
    if (!ref?.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    const theirs = want.get(branch);
    if (theirs && theirs !== sha && (await git(["merge-base", "--is-ancestor", sha, theirs], { cwd: root })).ok) continue;
    if (theirs && theirs !== sha && !(await git(["merge-base", "--is-ancestor", theirs, sha], { cwd: root })).ok) notes.push(`${branch} here and origin's have diverged; the forge has this one's`);
    want.set(branch, sha);
  }
  const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  const on = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  const main = [head.ok ? head.out.replace(/^origin\//, "") : "", on.ok ? on.out : "", "main"].find((b) => b && want.has(b)) ?? [...want.keys()][0];

  let created = false;
  const has = await api(`/repos/${repo}`);
  if (has.status === 404) {
    const made = await api("/user/repos", { method: "POST", body: JSON.stringify({ name, private: true, default_branch: main }) });
    if (!made.ok) throw new Error(`the forge wouldn't make ${repo}: ${made.error}`);
    created = true;
  } else if (!has.ok) throw new Error(`the forge: ${has.error}`);

  const pushed = await git(["push", "--quiet", url, ...[...want].map(([branch, sha]) => `${sha}:refs/heads/${branch}`), "refs/tags/*:refs/tags/*"], { cwd: root, ms: 30 * 60_000 });
  if (!pushed.ok) throw new Error(`${repo} is ${created ? "made, but" : "there already, and"} the push didn't go through, so origin is as it was: ${pushed.err}`);
  if (main) await api(`/repos/${repo}`, { method: "PATCH", body: JSON.stringify({ default_branch: main }) });

  let kept: string | null = null;
  if (origin) {
    kept = oldName(origin, new Set(remotes.keys()));
    const renamed = await git(["remote", "rename", "origin", kept], { cwd: root });
    if (!renamed.ok) throw new Error(`${repo} has everything, but origin couldn't be renamed to ${kept}: ${renamed.err}`);
  }
  const added = await git(["remote", "add", "origin", url], { cwd: root });
  if (!added.ok) throw new Error(`${repo} has everything, but it couldn't be made origin: ${added.err}`);
  if (!(await git(["fetch", "--quiet", "origin"], { cwd: root, ms: 5 * 60_000 })).ok) notes.push("couldn't fetch from the forge after the push");
  for (const [ref] of refs) {
    if (!ref?.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    await git(["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch], { cwd: root });
  }
  await git(["remote", "set-head", "origin", "--auto"], { cwd: root });
  return { repo, url, created, already: false, branches: want.size, kept, notes };
}
