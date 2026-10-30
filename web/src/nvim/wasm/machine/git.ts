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
          else if (a === "--git-common-dir" || a === "--git-dir") out.push(gitdir);
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
        const branch = await git.currentBranch({ fs, dir, fullname: !has("--short") });
        return branch ? ok(branch + "\n") : no("fatal: ref HEAD is not a symbolic ref", 128);
      }
      case "status": {
        const sep = has("-z") ? "\0" : "\n";
        const spec = rest.indexOf("--");
        const only = spec >= 0 && rest[spec + 1] === "." ? relative(top, cwd) : "";
        const rows = await git.statusMatrix({ fs, dir, filepaths: only ? [only] : undefined });
        const lines = rows.flatMap(([file, h, w, s]) => {
          const code = xy(h, w, s);
          return code ? [`${code} ${file}`] : [];
        });
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
        return ignored.length ? ok(ignored.map((n) => n + "\n").join("")) : no("");
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
        const commits = await git.log({ fs, dir, ref: "HEAD", depth: Number.isFinite(max) ? max : undefined });
        const out = commits
          .filter((c) => !has("--max-parents=0") || c.commit.parent.length === 0)
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
