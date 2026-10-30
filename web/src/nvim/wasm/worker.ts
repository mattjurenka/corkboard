// The Web Worker that runs Neovim compiled to wasm (~/neovim-wasm), for a
// page opened with ?wasm. neovim-wasm's own pre.js gives it stdio over the
// page's ring buffer; this gives it the bridge's machine:
//
// - HOSTFS: the machine's directories (bridge/wasm.ts mounts()) mounted at
//   the same paths, each call a blocking XHR to /host/fs. Neovim blocks
//   on it as on a disk; a worker may do that.
//   What never changes (the store's part of the runtimepath) comes whole
//   in a snapshot instead, and the rest is kept until the bridge tells of
//   something that could have changed it: over the internet each call is a
//   round trip, and starting Neovim makes hundreds.
// - /dev/corkboard-host: corkboard.wasm writes a request to it and reads
//   the answer, which comes from /host/lua (processes, terminals, watches).

import { decode, encode } from "@msgpack/msgpack";

export type Start = {
  type: "start";
  inputBuffer: SharedArrayBuffer;
  // The page's URL, which /host and the rest are found from.
  base: string;
  // Where nvim.js and the rest are, from it.
  wasm: string;
  // wasm.snapshot from the bridge, if it sent one.
  snapshot: Uint8Array | null;
  // Moves when the machine's files may have changed (rpc.ts).
  generation: SharedArrayBuffer;
  session: string;
  token: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  mounts: string[];
  // lstat's answers for what starting asks first (wasm.seeds).
  seeds: Record<string, [string | null, number[] | null]>;
};

// A classic worker (importScripts), typed here as the DOM lib allows.
declare const self: { onmessage: ((e: MessageEvent<Start>) => void) | null; Module: any };
declare function importScripts(...urls: string[]): void;

// emscripten's errno numbers (WASI's), by name, for what node reports.
const ERRNO: Record<string, number> = {
  E2BIG: 1, EACCES: 2, EAGAIN: 6, EBADF: 8, EBUSY: 10, EEXIST: 20, EFBIG: 22, EINTR: 27, EINVAL: 28, EIO: 29,
  EISDIR: 31, ELOOP: 32, EMFILE: 33, EMLINK: 34, ENAMETOOLONG: 37, ENFILE: 41, ENODEV: 43, ENOENT: 44,
  ENOMEM: 48, ENOSPC: 51, ENOSYS: 52, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58, ENXIO: 60, EPERM: 63,
  EPIPE: 64, EROFS: 69, ESPIPE: 70, ETIMEDOUT: 73, ETXTBSY: 74, EXDEV: 75,
};

// How much a read fetches at least: Lua and Neovim read in small pieces,
// and each fetch is a round trip.
const READ_AHEAD = 256 * 1024;

// What a path is, and where a link goes, missing or not, kept: a search of
// the runtimepath asks the same of each of its directories again and
// again, through Nix's chains of links. For good in the store, which
// doesn't change; otherwise until the generation moves, anything is changed
// from here, or a few seconds pass (for what changes and nobody says).
const CACHED = new Set(["lstat", "readlink"]);
const CACHE_MS = 10_000;
const MUTATING = new Set(["mkdir", "mkfile", "rename", "unlink", "rmdir", "symlink", "chmod", "fchmod", "utimes", "futimes", "truncate", "ftruncate", "write"]);
const WRITE_FLAGS = 0o1 | 0o2 | 0o100 | 0o1000; // O_WRONLY, O_RDWR, O_CREAT, O_TRUNC
const cache = new Map<string, { res: [string | null, unknown]; at: number; forever: boolean }>();

self.onmessage = (e: MessageEvent<Start>) => {
  if (e.data.type !== "start") return;
  const start = e.data;

  // Without waiting for the answer, which nobody wants.
  const send = (path: string, body: Uint8Array) => {
    const url = new URL(path, start.base);
    url.searchParams.set("s", start.session);
    fetch(url, { method: "POST", body: body as Uint8Array<ArrayBuffer>, headers: start.token ? { "x-corkboard-token": start.token } : {} }).catch(() => {});
  };
  const post = (path: string, body: Uint8Array): Uint8Array => {
    const url = new URL(path, start.base);
    url.searchParams.set("s", start.session);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, false);
    xhr.responseType = "arraybuffer";
    if (start.token) xhr.setRequestHeader("x-corkboard-token", start.token);
    xhr.send(body as Uint8Array<ArrayBuffer>);
    if (xhr.status !== 200) throw new Error(`${path}: ${xhr.status} ${xhr.statusText}`);
    return new Uint8Array(xhr.response);
  };

  self.Module = {
    inputBuffer: start.inputBuffer,
    arguments: ["--embed", ...start.args],
    locateFile: (name: string) => new URL(start.wasm + name, start.base).href,
    hostSetup({ FS, ENV }: { FS: any; ENV: Record<string, string> }) {
      const local = snapshotFs(start.snapshot);
      for (const [path, res] of Object.entries(start.seeds)) {
        cache.set(`lstat\0${path}`, { res, at: performance.now(), forever: path.startsWith("/nix/store/") });
      }
      const generation = new Int32Array(start.generation);
      let seen = 0;
      // Each open fd's path, and what openread brought of it, for its stream.
      const opened = new Map<number, string>();
      const heads = new Map<number, Uint8Array>();
      const head = (fd: number) => {
        const h = heads.get(fd);
        heads.delete(fd);
        return h;
      };
      const forget = (path: string | undefined, below: boolean) => {
        if (!path) return;
        cache.delete(`lstat\0${path}`);
        cache.delete(`readlink\0${path}`);
        if (below) for (const k of cache.keys()) if (k.slice(k.indexOf("\0") + 1).startsWith(path + "/")) cache.delete(k);
      };
      const remote = (op: string, args: unknown[]): [string | null, unknown] => {
        const now = Atomics.load(generation, 0);
        if (now !== seen) {
          seen = now;
          for (const [k, v] of cache) if (!v.forever) cache.delete(k);
        }
        const key = CACHED.has(op) ? `${op}\0${args[0]}` : undefined;
        const fresh = (k: string) => {
          const hit = cache.get(k);
          return hit && (hit.forever || performance.now() - hit.at < CACHE_MS) ? hit.res : undefined;
        };
        const hit = key && fresh(key);
        if (hit) return hit;
        // Where a path known not to be a link goes: nowhere.
        if (op === "readlink") {
          const st = fresh(`lstat\0${args[0]}`);
          if (st && !st[0] && ((st[1] as number[])[0] & S_IFMT) !== S_IFLNK) return ["EINVAL", null];
        }
        // What we change, we forget, and only that: the path (an fd's, for
        // what's done by fd), a rename's other end, and what was under a
        // directory that moved or went.
        if (MUTATING.has(op) || (op === "open" && (args[1] as number) & WRITE_FLAGS)) {
          const path = typeof args[0] === "number" ? opened.get(args[0]) : (args[0] as string);
          forget(path, op === "rename" || op === "rmdir" || op === "unlink");
          if (op === "rename" || op === "symlink") forget(args[1] as string, true);
        }
        // Nobody waits on a close.
        if (op === "close") {
          opened.delete(args[0] as number);
          send("host/fs", encode([op, ...args]));
          return [null, null];
        }
        const reading = op === "open" && !((args[1] as number) & WRITE_FLAGS);
        const call = op === "readdir" ? ["list", args[0]] : reading ? ["openread", args[0], args[1], READ_AHEAD] : [op, ...args];
        let res: [string | null, unknown];
        try {
          res = decode(post("host/fs", encode(call))) as [string | null, unknown];
        } catch (err) {
          console.error("hostfs:", op, args[0], err);
          return ["EIO", null];
        }
        if (!res[0] && op === "readdir") {
          const [names, stats] = res[1] as [string[], (number[] | null)[]];
          names.forEach((n, i) => cache.set(`lstat\0${args[0]}/${n}`, { res: stats[i] ? [null, stats[i]] : ["ENOENT", null], at: performance.now(), forever: false }));
          res = [null, names];
        }
        if (!res[0] && reading) {
          const [fd, head] = res[1] as [number, Uint8Array];
          heads.set(fd, head);
          res = [null, fd];
        }
        if (key) cache.set(key, { res, at: performance.now(), forever: (args[0] as string).startsWith("/nix/store/") });
        if (op === "open" && !res[0]) opened.set(res[1] as number, args[0] as string);
        if (op === "close") opened.delete(args[0] as number);
        return res;
      };
      const fs = (op: string, ...args: unknown[]): any => {
        const res = local(op, args) ?? remote(op, args);
        if (res[0]) throw new FS.ErrnoError(ERRNO[res[0]] ?? ERRNO.EIO);
        return res[1];
      };
      mountHost(FS, fs, head, start.mounts);

      // /dev/corkboard-host: one request and its answer per open.
      const dev = FS.makedev(65, 0);
      FS.registerDevice(dev, {
        open(stream: any) {
          stream.request = [];
          stream.answer = null;
        },
        write(stream: any, buffer: Int8Array, offset: number, length: number) {
          stream.request.push(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice());
          return length;
        },
        read(stream: any, buffer: Int8Array, offset: number, length: number) {
          if (!stream.answer) {
            const request = concat(stream.request);
            stream.answer = post("host/lua", request);
            // A process run start to end (vim.system's wait) may have
            // changed anything, and no event will say so.
            if ((decode(request) as unknown[])[0] === "run") for (const [k, v] of cache) if (!v.forever) cache.delete(k);
            stream.at = 0;
          }
          const n = Math.min(length, stream.answer.length - stream.at);
          buffer.set(new Int8Array(stream.answer.buffer, stream.answer.byteOffset + stream.at, n), offset);
          stream.at += n;
          return n;
        },
      });
      FS.mkdev("/dev/corkboard-host", 0o666, dev);

      // The machine's environment, less what has to stay the page's. Its
      // temporary files and log too, here in memory: what Neovim puts there
      // is its own (its server, which can't start here, tries first thing),
      // and its processes get what they need from corkboard.wasm.
      FS.mkdirTree("/.corkboard/tmp");
      const { VIMRUNTIME } = ENV;
      Object.assign(ENV, start.env, { VIMRUNTIME, TMPDIR: "/.corkboard/tmp", NVIM_LOG_FILE: "/.corkboard/nvim.log" });
      delete ENV.NVIM;
      FS.chdir(start.cwd);
    },
  };
  importScripts(new URL(`${start.wasm}nvim.js`, start.base).href);
};

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

// Answers from the bridge's snapshot (wasm.snapshot) for paths under its
// roots, or undefined for the bridge to answer. Its files open here, with
// fds of their own (below zero, which the bridge never gives).
function snapshotFs(bytes: Uint8Array | null) {
  if (!bytes) return () => undefined;
  const { roots, entries } = decode(bytes) as { roots: string[]; entries: Record<string, [number[], unknown]> };
  const under = (p: unknown) => typeof p === "string" && roots.some((r) => p === r || p.startsWith(r + "/"));
  const fds = new Map<number, [number[], Uint8Array]>();
  let next = -2;
  return (op: string, args: unknown[]): [string | null, unknown] | undefined => {
    const [a] = args;
    if (typeof a === "number") {
      const f = fds.get(a);
      if (!f) return undefined;
      if (op === "fstat") return [null, f[0]];
      if (op === "fsize") return [null, f[1].length];
      if (op === "read") {
        const [, length, position] = args as [number, number, number];
        return [null, f[1].subarray(position, position + length)];
      }
      if (op === "close") return fds.delete(a), [null, null];
      return ["EROFS", null];
    }
    if (!under(a)) return undefined;
    const e = entries[a as string];
    if (op === "lstat") return e ? [null, e[0]] : ["ENOENT", null];
    if (!e) return ["ENOENT", null];
    const type = e[0][0] & S_IFMT;
    if (op === "readlink") return type === S_IFLNK ? [null, e[1]] : ["EINVAL", null];
    if (op === "readdir") return type === S_IFDIR ? [null, e[1]] : ["ENOTDIR", null];
    if (op === "open") {
      if ((args[1] as number) & WRITE_FLAGS) return ["EROFS", null];
      // A directory's names are readdir's; its fd is only to have open.
      const bytes = type === S_IFDIR ? new Uint8Array(0) : e[1];
      // Too big to have been sent: the bridge reads it.
      if (!(bytes instanceof Uint8Array)) return undefined;
      fds.set(next, [e[0], bytes]);
      return [null, next--];
    }
    if (op === "statfs") return undefined;
    return ["EROFS", null];
  };
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// emscripten's NODEFS, with /host/fs in place of node's fs.
function mountHost(FS: any, fs: (op: string, ...args: unknown[]) => any, head: (fd: number) => Uint8Array | undefined, mounts: string[]) {
  const realPath = (node: any): string => {
    const parts: string[] = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    parts.push(node.mount.opts.root);
    return parts.reverse().join("/").replace(/\/+/g, "/");
  };
  const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
  const attr = (node: any, s: number[]) => {
    const [mode, size, mtime, atime, ctime, nlink, uid, gid, dev, rdev, blksize, blocks] = s;
    return {
      dev, ino: node.id, mode, nlink, uid, gid, rdev, size, blksize, blocks,
      atime: new Date(atime), mtime: new Date(mtime), ctime: new Date(ctime),
    };
  };
  const setattr = (node: any, a: any, path: string | null, fd: number | null) => {
    if (a.mode !== undefined) {
      fd !== null ? fs("fchmod", fd, a.mode) : fs("chmod", path, a.mode);
      node.mode = a.mode;
    }
    const at = a.atime ?? a.mtime;
    if (typeof at === "number") {
      const now = attr(node, fd !== null ? fs("fstat", fd) : fs("lstat", path));
      const atime = a.atime ?? now.atime.getTime();
      const mtime = a.mtime ?? now.mtime.getTime();
      fd !== null ? fs("futimes", fd, atime, mtime) : fs("utimes", path, atime, mtime);
    }
    if (a.size !== undefined) fd !== null ? fs("ftruncate", fd, a.size) : fs("truncate", path, a.size);
  };

  const HOSTFS: any = {
    mount: (mount: any) => HOSTFS.createNode(null, "/", fs("lstat", mount.opts.root)[0]),
    createNode(parent: any, name: string, mode: number) {
      if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) throw new FS.ErrnoError(ERRNO.EINVAL);
      const node = FS.createNode(parent, name, mode);
      node.node_ops = HOSTFS.node_ops;
      node.stream_ops = HOSTFS.stream_ops;
      return node;
    },
    node_ops: {
      getattr: (node: any) => attr(node, fs("lstat", realPath(node))),
      setattr: (node: any, a: any) => setattr(node, a, realPath(node), null),
      lookup(parent: any, name: string) {
        const path = join(realPath(parent), name);
        return HOSTFS.createNode(parent, name, fs("lstat", path)[0]);
      },
      mknod(parent: any, name: string, mode: number) {
        const node = HOSTFS.createNode(parent, name, mode);
        const path = realPath(node);
        FS.isDir(mode) ? fs("mkdir", path, mode) : fs("mkfile", path, mode);
        return node;
      },
      rename(old: any, dir: any, name: string) {
        fs("rename", realPath(old), join(realPath(dir), name));
        old.name = name;
      },
      unlink: (parent: any, name: string) => fs("unlink", join(realPath(parent), name)),
      rmdir: (parent: any, name: string) => fs("rmdir", join(realPath(parent), name)),
      readdir: (node: any) => fs("readdir", realPath(node)),
      symlink: (parent: any, name: string, target: string) => fs("symlink", target, join(realPath(parent), name)),
      readlink: (node: any) => fs("readlink", realPath(node)),
      statfs: (path: string) => fs("statfs", path),
    },
    stream_ops: {
      getattr: (stream: any) => attr(stream.node, fs("fstat", stream.nfd)),
      setattr: (stream: any, a: any) => setattr(stream.node, a, null, stream.nfd),
      open(stream: any) {
        stream.shared.refcount = 1;
        stream.nfd = fs("open", realPath(stream.node), stream.flags);
        const bytes = head(stream.nfd);
        stream.cache = bytes ? { at: 0, bytes, end: bytes.length < READ_AHEAD } : null;
      },
      close(stream: any) {
        if (stream.nfd !== undefined && !--stream.shared.refcount) fs("close", stream.nfd);
      },
      dup(stream: any) {
        stream.shared.refcount++;
      },
      read(stream: any, buffer: Int8Array, offset: number, length: number, position: number) {
        let c = stream.cache;
        const last = c && c.at + c.bytes.length;
        // A short answer was the end of the file, which the cache then holds.
        if (!c || position < c.at || (position + length > last && !(c.end && position <= last))) {
          const want = Math.max(length, READ_AHEAD);
          const bytes: Uint8Array = fs("read", stream.nfd, want, position);
          c = stream.cache = { at: position, bytes, end: bytes.length < want };
        }
        const from = position - c.at;
        const n = Math.max(0, Math.min(length, c.bytes.length - from));
        buffer.set(new Int8Array(c.bytes.buffer, c.bytes.byteOffset + from, n), offset);
        return n;
      },
      write(stream: any, buffer: Int8Array, offset: number, length: number, position: number) {
        stream.cache = null;
        return fs("write", stream.nfd, new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice(), position);
      },
      llseek(stream: any, offset: number, whence: number) {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2 && FS.isFile(stream.node.mode)) position += fs("fsize", stream.nfd);
        if (position < 0) throw new FS.ErrnoError(ERRNO.EINVAL);
        return position;
      },
    },
  };

  // emscripten keeps every path it has looked up, and answers access() and
  // the like from that alone: a path the machine has since lost would stay.
  // Each lookup of one of ours is checked with lstat, which the cache above
  // answers unless it has reason not to.
  const lookupNode = FS.lookupNode;
  FS.lookupNode = function (parent: any, name: string) {
    const node = lookupNode.call(FS, parent, name);
    if (node.node_ops !== HOSTFS.node_ops) return node;
    const path = realPath(node);
    if (path.startsWith("/nix/store/")) return node;
    let mode: number;
    try {
      mode = fs("lstat", path)[0];
    } catch (err) {
      FS.hashRemoveNode(node);
      throw err;
    }
    if ((mode & 0o170000) === (node.mode & 0o170000)) return node;
    FS.hashRemoveNode(node);
    return lookupNode.call(FS, parent, name);
  };

  for (const dir of mounts) {
    try {
      FS.mkdirTree(dir);
      FS.mount(HOSTFS, { root: dir }, dir);
    } catch (err) {
      console.error(`hostfs: couldn't mount ${dir}:`, err);
    }
  }
}
