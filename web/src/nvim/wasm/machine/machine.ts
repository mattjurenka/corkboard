// The machine of a page that has none (?wasm=ephemeral): a Web Worker
// beside Neovim's that holds the files, in memory (vfs.ts), and does
// what the bridge does for a page with one (bridge/wasm.ts).
//
// Neovim's worker can't wait on a promise: a file call has to be answered
// while it blocks. So the files live here, where git's work (isomorphic-
// git, which is all promises) can run too, and each call from there comes
// as a message whose answer is put in shared memory (link.ts).
//
// From the page:
//   { type: "load", bundle }   the plugins' files (wasm.bundle), under /plugins
//   { type: "clone", url, dir, ref, headers }
//                               the repository, before Neovim starts
//   { type: "link", port, reply }
//                               Neovim's worker's calls, on port
// To the page: { type: "done", id } or { type: "failed", id, error }, and
// { type: "progress", phase, loaded, total } while cloning, and { type:
// "event", args } for Neovim (corkboard.wasm's event: a process's output
// and end).

import "./buffer";
import { decode, encode } from "@msgpack/msgpack";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { runGit, type Ran } from "./git";
import { answer, REPLY_BYTES } from "./link";
import { Vfs } from "./vfs";

declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (msg: unknown) => void };

const vfs = new Vfs();
vfs.mkdirp("/work");
vfs.mkdirp("/plugins");

// The plugins' files, as bridge/wasm.ts's bundle() made them: by plugin,
// each path's mode and its bytes (a link's target).
function load(bytes: Uint8Array) {
  const plugins = decode(bytes) as Record<string, Record<string, [number, Uint8Array | string]>>;
  for (const [name, files] of Object.entries(plugins)) {
    const root = `/plugins/${name}`;
    vfs.mkdirp(root);
    for (const [path, [mode, content]] of Object.entries(files)) {
      const at = `${root}/${path}`;
      const type = mode & 0o170000;
      if (type === 0o040000) vfs.mkdirp(at);
      else if (type === 0o120000) vfs.op("symlink", [content, at]);
      else vfs.writeFile(at, content as Uint8Array, mode & 0o7777);
    }
  }
}

async function clone({ url, dir, ref, headers }: { url: string; dir: string; ref?: string; headers?: Record<string, string> }) {
  vfs.mkdirp(dir);
  await git.clone({
    fs: vfs.promises,
    http,
    dir,
    url,
    ref,
    singleBranch: true,
    depth: 1,
    headers,
    onProgress: ({ phase, loaded, total }) => self.postMessage({ type: "progress", phase, loaded, total }),
  });
}

// corkboard.wasm's calls (/host/lua's on a machine). The only program here
// is git (git.ts); anything else fails as a missing program does.
type Spec = { cmd: Uint8Array[]; cwd?: Uint8Array; stdin?: Uint8Array; pipe_stdin?: boolean; pty?: unknown };
const text = new TextDecoder();
const bytes = new TextEncoder();
const cwdOf = (s: Spec) => (s.cwd ? text.decode(s.cwd) : "/work");

function exec(s: Spec, stdin?: Uint8Array): Promise<Ran> {
  const [cmd, ...args] = s.cmd.map((c) => text.decode(c));
  if (cmd !== "git" || s.pty) return Promise.resolve({ code: 127, stdout: "", stderr: `${cmd}: no such program in this page\n` });
  return runGit(vfs, args, cwdOf(s), stdin);
}

// What spawn started: its stdin so far, until it's closed and it runs.
const procs = new Map<number, { stdin: Uint8Array[]; spec: Spec }>();
let nextProc = 1;
function start(id: number, s: Spec, stdin?: Uint8Array) {
  const event = (...args: unknown[]) => self.postMessage({ type: "event", args: [id, ...args] });
  exec(s, stdin).then((r) => {
    if (r.stdout) event("stdout", bytes.encode(r.stdout));
    if (r.stderr) event("stderr", bytes.encode(r.stderr));
    event("exit", r.code, 0);
  });
}

async function lua(op: string, a: any[]): Promise<unknown> {
  switch (op) {
    case "which": return text.decode(a[0]) === "git" ? "/usr/bin/git" : null;
    case "run": {
      const r = await exec(a[0], a[0].stdin);
      return { code: r.code, signal: 0, stdout: bytes.encode(r.stdout), stderr: bytes.encode(r.stderr) };
    }
    case "spawn": {
      const id = nextProc++;
      if (a[0].pipe_stdin) procs.set(id, { stdin: [], spec: a[0] });
      else start(id, a[0]);
      return id;
    }
    case "write": procs.get(a[0])?.stdin.push(a[1] instanceof Uint8Array ? a[1] : bytes.encode(String(a[1]))); return null;
    case "close_stdin": {
      const p = procs.get(a[0]);
      procs.delete(a[0]);
      if (p) start(a[0], p.spec, new Uint8Array(await new Blob(p.stdin as BlobPart[]).arrayBuffer()));
      return null;
    }
    case "kill": case "resize": return null;
    // Only Neovim changes these files, and it knows when it does.
    case "watch": return 0;
    case "unwatch": return null;
  }
  throw new Error(`no such op: ${op}`);
}

async function call(path: string, body: Uint8Array): Promise<Uint8Array> {
  if (path === "host/fs") {
    const [op, ...a] = decode(body) as [string, ...any[]];
    // A read may come back short; one that big couldn't come back at all.
    if (op === "read") a[1] = Math.min(a[1], REPLY_BYTES - 1024);
    try {
      return encode([null, vfs.op(op, a)]);
    } catch (err: any) {
      return encode([err.code ?? "EIO", null]);
    }
  }
  const [op, ...a] = decode(body, { rawStrings: true }) as [Uint8Array, ...unknown[]];
  try {
    return encode({ result: (await lua(text.decode(op), a)) ?? null });
  } catch (err: any) {
    return encode({ error: err.message ?? String(err) });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "link") return answer(data.port, data.reply, call);
  try {
    if (data.type === "load") load(data.bundle);
    else if (data.type === "clone") await clone(data);
    self.postMessage({ type: "done", id: data.id });
  } catch (err: any) {
    self.postMessage({ type: "failed", id: data.id, error: err?.message ?? String(err) });
  }
};
