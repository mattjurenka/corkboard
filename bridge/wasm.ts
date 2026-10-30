// A page whose Neovim runs in the page, compiled to wasm (~/neovim-wasm),
// rather than here as `nvim --embed`. Neovim there has no processes and only
// an in-memory filesystem; this is the machine it stands in for:
//
//   /host/fs   the filesystem, from the worker's HOSTFS (web/src/nvim/wasm):
//              each call synchronous, a blocking XHR from the worker
//   /host/lua  processes, terminals and file watching, from corkboard.wasm
//              in Neovim, by way of a device file the worker answers
//
// Both carry msgpack: [op, ...args] in, [error, result] out. What happens
// later (a process's output and exit, a watched file changing) goes to
// Neovim as Lua over the page's socket (deliver in server.ts), and so do
// the RPC calls from Claude Code's hooks, which dial $NVIM: here, a socket
// per page that stands in for Neovim's own server.

import { closeSync, constants, fstatSync, readFileSync, realpathSync, ftruncateSync, futimesSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, renameSync, rmdirSync, statfsSync, symlinkSync, truncateSync, unlinkSync, utimesSync, chmodSync, writeFileSync, writeSync, fchmodSync, watch, type FSWatcher, type Stats, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { decode, decodeMultiStream, encode } from "@msgpack/msgpack";

// To Neovim: Lua to run there, with its arguments. Bytes go as they are
// (the page sends them on as msgpack bin, which Neovim takes as a string).
export type Exec = (code: string, ...args: unknown[]) => void;
// A hook's request, which the page puts to Neovim and answers (reply).
// A null tag is a notification, which has no answer.
export type Request = (tag: string | null, method: string, params: unknown[]) => void;

const EVENT = "require('corkboard.wasm').event(...)";

// What Neovim's open() flags mean to node: the same numbers (emscripten's
// musl uses Linux's generic values), less those it has no use for.
const IGNORED_FLAGS = 0o10000000 /* O_PATH */ | 0o4000 /* O_NONBLOCK */ | 0o100000 /* O_LARGEFILE */ | 0o2000000 /* O_CLOEXEC */ | 0o200000 /* O_DIRECTORY */;

const stat = (s: Stats) => [s.mode, s.size, s.mtimeMs, s.atimeMs, s.ctimeMs, s.nlink, s.uid, s.gid, s.dev, s.rdev, s.blksize, s.blocks];

// The top-level directories the page mounts from here, at the same paths,
// so a path means the same to Neovim as to the processes it starts. /usr
// stays the page's: Neovim's runtime is there.
const NOT_MOUNTED = new Set(["dev", "proc", "sys", "usr"]);
export function mounts(): string[] {
  return readdirSync("/", { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_MOUNTED.has(d.name))
    .map((d) => `/${d.name}`);
}

// The trees at roots, which never change (store paths on the runtimepath),
// whole: each path's stat, and a directory's names, a link's target or a
// small file's bytes. The page answers from it rather than asking, which
// over the internet is most of what starting Neovim costs (worker.ts).
const SNAPSHOT_FILE_MAX = 128 * 1024;
export function snapshotRoots(dirs: string[]): string[] {
  return [...new Set(dirs.map((d) => realpathSync(d)).filter((d) => d.startsWith("/nix/store/")))];
}
export function snapshot(roots: string[]): Uint8Array {
  const entries: Record<string, [number[], unknown]> = {};
  const walk = (path: string) => {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) entries[path] = [stat(s), readlinkSync(path)];
    else if (s.isDirectory()) {
      const names = readdirSync(path);
      entries[path] = [stat(s), names];
      for (const name of names) walk(`${path}/${name}`);
    } else entries[path] = [stat(s), s.size <= SNAPSHOT_FILE_MAX ? readFileSync(path) : null];
  };
  for (const root of roots) walk(root);
  return encode({ roots, entries });
}

// What every start asks first, answered with the page's first message
// rather than one at a time: the mounts, the directories above the project
// and home, and where Neovim looks for config and data. lstat's [error,
// stat], by path, as /host/fs would give them.
export function seeds(cwd: string, home: string, env: Record<string, string | undefined>): Record<string, [string | null, number[] | null]> {
  const paths = new Set<string>(mounts());
  const above = (p: string) => {
    for (let d = p; d !== "/" && d; d = dirname(d)) paths.add(d);
  };
  const config = env.XDG_CONFIG_HOME ?? `${home}/.config`;
  const data = env.XDG_DATA_HOME ?? `${home}/.local/share`;
  const state = env.XDG_STATE_HOME ?? `${home}/.local/state`;
  for (const p of [cwd, home, `${config}/nvim`, `${data}/nvim/site/after`, `${state}/nvim/shada`]) above(p);
  for (const d of (env.XDG_CONFIG_DIRS ?? "/etc/xdg").split(":")) above(`${d}/nvim/after`);
  for (const d of (env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":")) if (!d.startsWith("/usr/")) above(`${d}/nvim/site/after`);
  const out: Record<string, [string | null, number[] | null]> = {};
  for (const p of paths) {
    try {
      out[p] = [null, stat(lstatSync(p))];
    } catch (err: any) {
      out[p] = [err.code ?? "EIO", null];
    }
  }
  return out;
}

type Proc = {
  kill: (signal?: string) => void;
  write: (data: Uint8Array | string) => void;
  closeStdin: () => void;
  resize: (rows: number, cols: number) => void;
};

export class Host {
  readonly id = randomBytes(16).toString("hex");
  // Neovim's server, as hooks and Pepper's hand_off find it.
  readonly socket = `${process.env.XDG_RUNTIME_DIR ?? tmpdir()}/corkboard-wasm-${this.id.slice(0, 12)}.sock`;
  private fds = new Set<number>();
  private procs = new Map<number, Proc>();
  private watchers = new Map<number, FSWatcher>();
  private nextId = 1;
  private server: Server;
  private hooks = new Map<string, { socket: Socket; id: number }>();
  private closed = false;

  constructor(
    private exec: Exec,
    private request: Request,
    private env: Record<string, string>,
  ) {
    this.server = createServer((socket) => this.hook(socket));
    this.server.listen(this.socket);
  }

  close() {
    this.closed = true;
    for (const fd of this.fds) try { closeSync(fd); } catch {}
    for (const p of this.procs.values()) p.kill("SIGHUP");
    for (const w of this.watchers.values()) w.close();
    this.server.close();
    try { rmSync(this.socket); } catch {}
  }

  // /host/fs: the worker's filesystem calls, as node's fs does them.
  fs(body: Uint8Array): Uint8Array {
    const [op, ...a] = decode(body) as [string, ...any[]];
    try {
      return encode([null, this.fsOp(op, a)]);
    } catch (err: any) {
      return encode([err.code ?? "EIO", null]);
    }
  }

  private fsOp(op: string, a: any[]): unknown {
    switch (op) {
      case "lstat": return stat(lstatSync(a[0]));
      case "fstat": return stat(fstatSync(a[0]));
      case "readdir": return readdirSync(a[0]);
      // A directory's names, and each one's lstat (null when it went in
      // between), which the page would ask next.
      case "list": {
        const names = readdirSync(a[0]);
        return [names, names.map((n) => {
          try {
            return stat(lstatSync(`${a[0]}/${n}`));
          } catch {
            return null;
          }
        })];
      }
      case "readlink": return readlinkSync(a[0]);
      case "mkdir": return mkdirSync(a[0], a[1]), null;
      case "mkfile": return writeFileSync(a[0], "", { mode: a[1], flag: "wx" }), null;
      case "rename": return renameSync(a[0], a[1]), null;
      case "unlink": return unlinkSync(a[0]), null;
      case "rmdir": return rmdirSync(a[0]), null;
      case "symlink": return symlinkSync(a[0], a[1]), null;
      case "chmod": return chmodSync(a[0], a[1]), null;
      case "fchmod": return fchmodSync(a[0], a[1]), null;
      case "utimes": return utimesSync(a[0], a[1] / 1000, a[2] / 1000), null;
      case "futimes": return futimesSync(a[0], a[1] / 1000, a[2] / 1000), null;
      case "truncate": return truncateSync(a[0], a[1]), null;
      case "ftruncate": return ftruncateSync(a[0], a[1]), null;
      case "statfs": {
        const s = statfsSync(a[0]);
        return { bsize: s.bsize, frsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail, files: s.files, ffree: s.ffree, fsid: 0, flags: 0, namelen: 255 };
      }
      case "open": {
        const fd = openSync(a[0], a[1] & ~IGNORED_FLAGS, a[2] ?? 0o666);
        this.fds.add(fd);
        return fd;
      }
      case "close": return this.fds.delete(a[0]) && closeSync(a[0]), null;
      // open, for reading, with the first a[2] bytes: most files are read
      // whole, and this is the one round trip for it.
      case "openread": {
        const fd = openSync(a[0], a[1] & ~IGNORED_FLAGS);
        this.fds.add(fd);
        const buf = Buffer.alloc(a[2]);
        let n = 0;
        try {
          if (!fstatSync(fd).isDirectory()) n = readSync(fd, buf, 0, a[2], 0);
        } catch {}
        return [fd, buf.subarray(0, n)];
      }
      case "read": {
        const buf = Buffer.alloc(a[1]);
        const n = readSync(a[0], buf, 0, a[1], a[2]);
        return buf.subarray(0, n);
      }
      case "write": return writeSync(a[0], a[1], 0, a[1].length, a[2]);
      case "fsize": return fstatSync(a[0]).size;
    }
    throw Object.assign(new Error(op), { code: "ENOSYS" });
  }

  // /host/lua: corkboard.wasm's calls. Strings arrive as bytes (Lua's are),
  // so text is decoded where it's wanted as text.
  async lua(body: Uint8Array): Promise<Uint8Array> {
    const [op, ...a] = decode(body, { rawStrings: true }) as [Uint8Array, ...any[]];
    try {
      return encode({ result: (await this.luaOp(text(op), a)) ?? null });
    } catch (err: any) {
      return encode({ error: err.message ?? String(err) });
    }
  }

  private async luaOp(op: string, a: any[]): Promise<unknown> {
    switch (op) {
      case "run": return this.run(spec(a[0]));
      case "spawn": return this.spawn(spec(a[0]));
      case "write": return this.procs.get(a[0])?.write(a[1]);
      case "close_stdin": return this.procs.get(a[0])?.closeStdin();
      case "kill": return this.procs.get(a[0])?.kill(a[1] ? text(a[1]) : undefined);
      case "resize": return this.procs.get(a[0])?.resize(a[1], a[2]);
      case "which": return Bun.which(text(a[0]), { PATH: this.env.PATH }) ?? null;
      case "watch": return this.watch(text(a[0]));
      case "unwatch": return this.watchers.get(a[0])?.close(), this.watchers.delete(a[0]), null;
    }
    throw new Error(`no such op: ${op}`);
  }

  // A process's environment: this machine's, as Neovim's would have been,
  // with its own on top.
  private envFor(s: Spec): Record<string, string> {
    const base = s.clear_env ? {} : { ...this.env };
    return { ...base, NVIM: this.socket, ...s.env };
  }

  // vim.system(...):wait(): the whole process, start to end.
  private async run(s: Spec) {
    const proc = Bun.spawn(s.cmd, { cwd: s.cwd, env: this.envFor(s), stdin: s.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = s.timeout ? setTimeout(() => proc.kill("SIGTERM"), s.timeout) : undefined;
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).bytes(), proc.exited]);
    clearTimeout(timer);
    return { code, signal: proc.signalCode ? signalNumber(proc.signalCode) : 0, stdout, stderr };
  }

  // A process left running: its output, and its end, come to Neovim as
  // events. With pty, in a terminal (jobstart's term = true).
  private spawn(s: Spec): number {
    const id = this.nextId++;
    const event = (...args: unknown[]) => !this.closed && this.exec(EVENT, id, ...args);
    const env = this.envFor(s);
    let proc: ReturnType<typeof Bun.spawn>;
    // Its output, all of which is in before its end is told.
    let output: Promise<unknown> = Promise.resolve();
    if (s.pty) {
      proc = Bun.spawn(s.cmd, {
        cwd: s.cwd,
        env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: { cols: s.pty.cols, rows: s.pty.rows, data: (_t, data) => event("stdout", data) },
      });
      const term = proc.terminal!;
      this.procs.set(id, {
        kill: (signal) => proc.kill((signal as any) ?? "SIGTERM"),
        write: (data) => void term.write(data),
        closeStdin: () => {},
        resize: (rows, cols) => term.resize(cols, rows),
      });
    } else {
      proc = Bun.spawn(s.cmd, { cwd: s.cwd, env, stdin: s.pipe_stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
      const stdin = proc.stdin as import("bun").FileSink | undefined;
      const pump = async (stream: ReadableStream<Uint8Array>, name: string) => {
        for await (const chunk of stream) event(name, chunk);
      };
      output = Promise.all([pump(proc.stdout as ReadableStream, "stdout"), pump(proc.stderr as ReadableStream, "stderr")]);
      this.procs.set(id, {
        kill: (signal) => proc.kill((signal as any) ?? "SIGTERM"),
        write: (data) => {
          stdin?.write(data);
          stdin?.flush();
        },
        closeStdin: () => void stdin?.end(),
        resize: () => {},
      });
    }
    (async () => {
      const code = await proc.exited;
      await output.catch(() => {});
      this.procs.delete(id);
      event("exit", code, proc.signalCode ? signalNumber(proc.signalCode) : 0);
    })();
    return id;
  }

  private watch(path: string): number {
    const id = this.nextId++;
    const w = watch(path, (kind, name) => !this.closed && this.exec(EVENT, id, "watch", name ?? null, kind));
    w.on("error", () => {});
    this.watchers.set(id, w);
    return id;
  }

  // A hook's connection to "Neovim": its requests and notifications go on
  // to the page's Neovim; Neovim never calls it back.
  private async hook(socket: Socket) {
    const conn = this.nextId++;
    socket.on("error", () => {});
    try {
      const stream = (async function* () {
        for await (const chunk of socket) yield chunk as Uint8Array;
      })();
      for await (const msg of decodeMultiStream(stream)) {
        if (!Array.isArray(msg)) continue;
        if (msg[0] === 2) this.request(null, msg[1] as string, msg[2] as unknown[]);
        else if (msg[0] === 0) {
          const tag = `${conn}:${msg[1]}`;
          this.hooks.set(tag, { socket, id: msg[1] as number });
          this.request(tag, msg[2] as string, msg[3] as unknown[]);
        }
      }
    } catch {}
  }

  // The page's answer to a hook's request.
  reply(tag: string, error: unknown, result: unknown) {
    const h = this.hooks.get(tag);
    if (!h) return;
    this.hooks.delete(tag);
    if (!h.socket.destroyed) h.socket.write(encode([1, h.id, error ?? null, result ?? null]));
  }
}

type Spec = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  clear_env?: boolean;
  // run's: what to give it on stdin.
  stdin?: Uint8Array;
  // spawn's: whether it has a stdin to write to, or none (as rg wants, or
  // it searches its stdin).
  pipe_stdin?: boolean;
  timeout?: number;
  pty?: { rows: number; cols: number };
};

const decoder = new TextDecoder();
const text = (b: unknown) => (b instanceof Uint8Array ? decoder.decode(b) : String(b));

function spec(raw: any): Spec {
  const env: Record<string, string> = {};
  if (raw.env) for (const [k, v] of Object.entries(raw.env)) env[k] = text(v);
  return {
    cmd: (raw.cmd as Uint8Array[]).map(text),
    cwd: raw.cwd ? text(raw.cwd) : undefined,
    env,
    clear_env: !!raw.clear_env,
    stdin: raw.stdin,
    pipe_stdin: !!raw.pipe_stdin,
    timeout: raw.timeout,
    pty: raw.pty,
  };
}

const signalNumber = (name: string) => (constants.os?.signals as Record<string, number> | undefined)?.[name] ?? 0;
