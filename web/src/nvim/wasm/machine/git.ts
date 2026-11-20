// `git`, for a page with no machine: the commands corkboard's Lua runs
// (util.git and the file browser in init.lua), done with isomorphic-git on
// the page's files, printing what git would. Anything else fails as git
// does when it can't, with what it wanted on stderr.

import git from "isomorphic-git";
import type { Vfs } from "./vfs";

export type Ran = { code: number; stdout: string; stderr: string };

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const no = (stderr: string, code = 1): Ran => ({ code, stdout: "", stderr });

// The working tree cwd is in: the nearest directory with a .git.
function topOf(vfs: Vfs, cwd: string): string | undefined {
  for (let dir = cwd.replace(/\/+$/, "") || "/"; ; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
    try {
      vfs.op("lstat", [`${dir}/.git`]);
      return dir;
    } catch {}
    if (dir === "/") return undefined;
  }
}

// A revision log was given that names no commit.
class Unknown extends Error {
  constructor(readonly ref: string) {
    super(ref);
  }
}

const relative = (top: string, path: string) => (path === top ? "" : path.slice(top.length + 1));

// status's XY for each of statusMatrix's [HEAD, workdir, stage] (see its
// docs); unchanged files have none.
function xy(head: number, work: number, stage: number): string | undefined {
  if (head === 0) return stage === 0 ? "??" : stage === 2 && work === 2 ? "A " : work === 0 ? "AD" : "AM";
  if (work === 0) return stage === 0 ? "D " : " D";
  if (stage === 0) return "D ";
  if (stage === 1) return work === 1 ? undefined : " M";
  return work === 2 && stage === 2 ? "M " : "MM";
}

export async function runGit(vfs: Vfs, args: string[], cwd: string, stdin?: Uint8Array): Promise<Ran> {
  const fs = vfs.promises;
  const top = topOf(vfs, cwd);
  if (!top) return no("fatal: not a git repository (or any of the parent directories): .git", 128);
  const dir = top;
  const gitdir = `${top}/.git`;
  const [cmd, ...rest] = args;
  const has = (flag: string) => rest.includes(flag);
  try {
    switch (cmd) {
      case "rev-parse": {
        const out: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === "--show-toplevel") out.push(top);
          else if (a === "--git-common-dir" || a === "--git-dir" || a === "--absolute-git-dir") out.push(gitdir);
          else if (a === "--show-prefix") out.push(relative(top, cwd) ? `${relative(top, cwd)}/` : "");
          else if (a === "--is-inside-work-tree") out.push("true");
          else if (a === "--abbrev-ref") out.push((await git.currentBranch({ fs, dir })) ?? "HEAD"), i++;
          else if (a.startsWith("--") && a !== "--short" && a !== "--verify" && a !== "--quiet") continue;
          else if (!a.startsWith("--")) {
            const oid = await git.resolveRef({ fs, dir, ref: a }).catch(() => undefined);
            if (!oid) return has("--quiet") ? no("") : no(`fatal: ambiguous argument '${a}': unknown revision`, 128);
            out.push(has("--short") ? oid.slice(0, 7) : oid);
          }
        }
        return ok(out.map((l) => l + "\n").join(""));
      }
      case "symbolic-ref": {
        // HEAD, or the ref named (origin's HEAD, which a clone of one branch hasn't).
        const ref = rest.find((a) => !a.startsWith("-")) ?? "HEAD";
        const text = await fs.readFile(`${gitdir}/${ref}`, "utf8").catch(() => "");
        const to = /^ref: (\S+)/.exec(text as string)?.[1];
        if (!to) return no(`fatal: ref ${ref} is not a symbolic ref`, 128);
        return ok((has("--short") ? to.replace(/^refs\/(heads|remotes|tags)\//, "") : to) + "\n");
      }
      case "status": {
        const sep = has("-z") ? "\0" : "\n";
        const spec = rest.indexOf("--");
        const only = spec >= 0 && rest[spec + 1] === "." ? relative(top, cwd) : "";
        const rows = await git.statusMatrix({ fs, dir, filepaths: only ? [only] : undefined });
        const untracked = rest.find((a) => a.startsWith("--untracked-files="))?.slice(18) ?? (has("-uno") ? "no" : has("-uall") ? "all" : "normal");
        const lines: string[] = [];
        const others: string[] = [];
        for (const [file, h, w, s] of rows) {
          const code = xy(h, w, s);
          if (code === "??") others.push(file);
          else if (code) lines.push(`${code} ${file}`);
        }
        // Untracked files after the rest, as git has them; by default a
        // directory with nothing tracked in it as itself, once.
        if (untracked !== "no") {
          const tracked = new Set<string>();
          for (const [file, h, , s] of rows) if (h || s) for (let i = file.indexOf("/"); i > 0; i = file.indexOf("/", i + 1)) tracked.add(file.slice(0, i));
          const shown = new Set<string>();
          for (const file of others) {
            let at = file;
            if (untracked !== "all")
              for (let i = file.indexOf("/"); i > 0; i = file.indexOf("/", i + 1))
                if (!tracked.has(file.slice(0, i))) {
                  at = file.slice(0, i + 1);
                  break;
                }
            if (!shown.has(at)) shown.add(at), lines.push(`?? ${at}`);
          }
        }
        return ok(lines.map((l) => l + sep).join(""));
      }
      case "check-ignore": {
        const names = has("--stdin") ? new TextDecoder().decode(stdin ?? new Uint8Array()).split("\n") : rest.filter((a) => !a.startsWith("-"));
        const prefix = relative(top, cwd);
        const ignored: string[] = [];
        for (const name of names.filter(Boolean)) {
          const filepath = prefix ? `${prefix}/${name}` : name;
          // A pattern for directories only (node_modules/) matches with the slash.
          const isDir = await fs.lstat(`${top}/${filepath}`).then((st) => st.isDirectory(), () => false);
          if (await git.isIgnored({ fs, dir, filepath: isDir ? `${filepath}/` : filepath })) ignored.push(name);
        }
        return ignored.length ? ok(has("-q") || has("--quiet") ? "" : ignored.map((n) => n + "\n").join("")) : no("");
      }
      case "log": {
        // The first commit, which a shallow clone doesn't have: none, as
        // for a repository with no commits yet.
        if (has("--max-parents=0")) {
          const shallow = await fs.readFile(`${gitdir}/shallow`).then(() => true, () => false);
          if (shallow) return no("");
        }
        const format = rest.find((a) => a.startsWith("--format="))?.slice(9) ?? "%H %s";
        const max = has("--max-parents=0") ? Infinity : Number(rest.find((a) => /^-n?\d+$/.test(a))?.replace(/^-n?/, "") ?? Infinity);
        // What to show and what not: rev, a..b (an empty side is HEAD) and ^rev.
        const show: string[] = [];
        const hide: string[] = [];
        for (const a of rest.filter((a) => !a.startsWith("-"))) {
          const dots = a.indexOf("..");
          if (dots >= 0) hide.push(a.slice(0, dots) || "HEAD"), show.push(a.slice(dots + 2) || "HEAD");
          else if (a.startsWith("^")) hide.push(a.slice(1));
          else show.push(a);
        }
        const walk = async (ref: string) => {
          const oid = await git.resolveRef({ fs, dir, ref }).catch(() => git.expandOid({ fs, dir, oid: ref }).catch(() => undefined));
          if (!oid) throw new Unknown(ref);
          return git.log({ fs, dir, ref: oid });
        };
        let hidden: Set<string>;
        let commits: Awaited<ReturnType<typeof git.log>>;
        try {
          hidden = new Set((await Promise.all(hide.map(walk))).flat().map((c) => c.oid));
          const seen = new Set<string>();
          commits = (await Promise.all((show.length ? show : ["HEAD"]).map(walk)))
            .flat()
            .filter((c) => !hidden.has(c.oid) && !seen.has(c.oid) && seen.add(c.oid));
        } catch (e) {
          if (e instanceof Unknown) return no(`fatal: ambiguous argument '${e.ref}': unknown revision or path not in the working tree.`, 128);
          throw e;
        }
        const out = commits
          .filter((c) => !has("--max-parents=0") || c.commit.parent.length === 0)
          .slice(0, max)
          .map((c) =>
            format
              .replace(/%H/g, c.oid)
              .replace(/%h/g, c.oid.slice(0, 7))
              .replace(/%ct/g, String(c.commit.committer.timestamp))
              .replace(/%s/g, c.commit.message.split("\n")[0]),
          );
        return ok(out.map((l) => l + "\n").join(""));
      }
      case "config": {
        if (rest[0] === "--get-regexp") {
          const re = new RegExp(rest[1]);
          const remotes = await git.listRemotes({ fs, dir });
          return ok(remotes.map((r) => `remote.${r.remote}.url ${r.url}`).filter((l) => re.test(l.split(" ")[0])).map((l) => l + "\n").join(""));
        }
        if (rest[0] === "--get") {
          const value = await git.getConfig({ fs, dir, path: rest[1] });
          return value == null ? no("") : ok(`${value}\n`);
        }
        if (rest.length === 2 && !rest[0].startsWith("-")) return await git.setConfig({ fs, dir, path: rest[0], value: rest[1] }), ok();
        break;
      }
      case "remote": {
        if (rest[0] === "get-url") {
          const url = await git.getConfig({ fs, dir, path: `remote.${rest[1]}.url` });
          return url ? ok(`${url}\n`) : no(`error: No such remote '${rest[1]}'`, 2);
        }
        break;
      }
      case "worktree": {
        if (rest[0] === "list") {
          const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
          const branch = await git.currentBranch({ fs, dir, fullname: true });
          return ok(`worktree ${top}\nHEAD ${oid}\n${branch ? `branch ${branch}` : "detached"}\n\n`);
        }
        break;
      }
    }
  } catch (err: any) {
    return no(`fatal: ${err?.message ?? err}`, 128);
  }
  return no(`git ${args.join(" ")}: not in a page with no machine`, 1);
}
