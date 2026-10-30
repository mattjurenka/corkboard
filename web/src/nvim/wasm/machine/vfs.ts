// The page's own filesystem, in memory, for a page with no machine (?wasm=
// ephemeral): what the bridge's /host/fs does on a real disk (bridge/wasm.ts
// fsOp), op for op, so Neovim's worker mounts it the same way. Also as the
// promise fs isomorphic-git wants, for the clone and git's other work.
//
// Errors are thrown as { code } with node's names, which both sides read.

type Node = {
  ino: number;
  mode: number;
  mtime: number;
  atime: number;
  ctime: number;
  // A file's bytes (the first size of them), a directory's entries, a link's target.
  data?: Uint8Array;
  size?: number;
  children?: Map<string, Node>;
  target?: string;
};

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const O_ACCMODE = 0o3;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

export class Vfs {
  private nextIno = 1;
  private root: Node = this.node(S_IFDIR | 0o755);
  private fds = new Map<number, { node: Node; flags: number }>();
  private nextFd = 3;

  private node(mode: number): Node {
    const now = Date.now();
    const n: Node = { ino: this.nextIno++, mode, mtime: now, atime: now, ctime: now };
    if ((mode & S_IFMT) === S_IFDIR) n.children = new Map();
    if ((mode & S_IFMT) === S_IFREG) (n.data = new Uint8Array(0)), (n.size = 0);
    return n;
  }

  private isDir = (n: Node) => (n.mode & S_IFMT) === S_IFDIR;
  private isLink = (n: Node) => (n.mode & S_IFMT) === S_IFLNK;

  // The node at path, following links on the way and, when follow is set,
  // at the end too; with its parent and its name there.
  private walk(path: string, follow: boolean, depth = 0): { node?: Node; parent: Node; name: string } {
    if (depth > 40) fail("ELOOP");
    if (!path.startsWith("/")) fail("EINVAL");
    const parts = path.split("/").filter((p) => p && p !== ".");
    let dir = this.root;
    const stack: Node[] = [];
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const last = i === parts.length - 1;
      if (name === "..") {
        dir = stack.pop() ?? this.root;
        if (last) return { node: dir, parent: stack.at(-1) ?? this.root, name: "." };
        continue;
      }
      if (!this.isDir(dir)) fail("ENOTDIR");
      const next = dir.children!.get(name);
      if (last && (!next || !follow || !this.isLink(next))) return { node: next, parent: dir, name };
      if (!next) fail("ENOENT");
      if (this.isLink(next!)) {
        const base = "/" + parts.slice(0, i).join("/");
        const to = next!.target!.startsWith("/") ? next!.target! : `${base}/${next!.target}`;
        const rest = parts.slice(i + 1).join("/");
        return this.walk(rest ? `${to}/${rest}` : to, follow, depth + 1);
      }
      stack.push(dir);
      dir = next!;
    }
    return { node: dir, parent: stack.at(-1) ?? this.root, name: "." };
  }

  private get(path: string, follow = true): Node {
    return this.walk(path, follow).node ?? fail("ENOENT");
  }

  private fd(fd: number) {
    return this.fds.get(fd) ?? fail("EBADF");
  }

  // As bridge/wasm.ts's stat(): what the worker's HOSTFS reads.
  private stat(n: Node): number[] {
    const size = this.isDir(n) ? 4096 : this.isLink(n) ? n.target!.length : n.size!;
    return [n.mode, size, n.mtime, n.atime, n.ctime, this.isDir(n) ? 2 : 1, 1000, 1000, 1, 0, 4096, Math.ceil(size / 512)];
  }

  private add(path: string, mode: number): Node {
    const { node, parent, name } = this.walk(path, false);
    if (node) fail("EEXIST");
    if (!this.isDir(parent)) fail("ENOTDIR");
    const n = this.node(mode);
    parent.children!.set(name, n);
    parent.mtime = Date.now();
    return n;
  }

  private resize(n: Node, size: number) {
    if (size > n.data!.length) {
      const grown = new Uint8Array(Math.max(size, n.data!.length * 2, 256));
      grown.set(n.data!.subarray(0, n.size));
      n.data = grown;
    } else if (size < n.size!) n.data!.fill(0, size, n.size);
    n.size = size;
    n.mtime = n.ctime = Date.now();
  }

  // ---- /host/fs's ops (bridge/wasm.ts fsOp), by name.

  op(op: string, a: any[]): unknown {
    switch (op) {
      case "lstat": return this.stat(this.get(a[0], false));
      case "fstat": return this.stat(this.fd(a[0]).node);
      case "readdir": return this.readdir(a[0]);
      case "list": {
        const dir = this.get(a[0]);
        const names = this.readdir(a[0]);
        return [names, names.map((n) => this.stat(dir.children!.get(n)!))];
      }
      case "readlink": {
        const n = this.get(a[0], false);
        return this.isLink(n) ? n.target : fail("EINVAL");
      }
      case "mkdir": return this.add(a[0], S_IFDIR | ((a[1] ?? 0o777) & 0o7777)), null;
      case "mkfile": return this.add(a[0], S_IFREG | ((a[1] ?? 0o666) & 0o7777)), null;
      case "rename": return this.rename(a[0], a[1]), null;
      case "unlink": return this.unlink(a[0]), null;
      case "rmdir": return this.rmdir(a[0]), null;
      case "symlink": {
        const n = this.add(a[1], S_IFLNK | 0o777);
        n.target = a[0];
        return null;
      }
      case "chmod": case "fchmod": {
        const n = op === "chmod" ? this.get(a[0]) : this.fd(a[0]).node;
        n.mode = (n.mode & S_IFMT) | (a[1] & 0o7777);
        n.ctime = Date.now();
        return null;
      }
      case "utimes": case "futimes": {
        const n = op === "utimes" ? this.get(a[0]) : this.fd(a[0]).node;
        n.atime = a[1];
        n.mtime = a[2];
        return null;
      }
      case "truncate": case "ftruncate": {
        const n = op === "truncate" ? this.get(a[0]) : this.fd(a[0]).node;
        if (this.isDir(n)) fail("EISDIR");
        this.resize(n, a[1]);
        return null;
      }
      case "statfs": return { bsize: 4096, frsize: 4096, blocks: 1 << 20, bfree: 1 << 19, bavail: 1 << 19, files: 1 << 20, ffree: 1 << 19, fsid: 0, flags: 0, namelen: 255 };
      case "open": return this.open(a[0], a[1], a[2]);
      case "openread": {
        const fd = this.open(a[0], a[1]);
        const n = this.fds.get(fd)!.node;
        return [fd, this.isDir(n) ? new Uint8Array(0) : n.data!.slice(0, Math.min(n.size!, a[2]))];
      }
      case "close": return this.fds.delete(a[0]), null;
      case "read": {
        const { node } = this.fd(a[0]);
        if (this.isDir(node)) fail("EISDIR");
        node.atime = Date.now();
        return node.data!.slice(a[2], Math.min(node.size!, a[2] + a[1]));
      }
      case "write": return this.write(a[0], a[1], a[2]);
      case "fsize": return this.fd(a[0]).node.size ?? 0;
    }
    return fail("ENOSYS");
  }

  private readdir(path: string): string[] {
    const n = this.get(path);
    return this.isDir(n) ? [...n.children!.keys()] : fail("ENOTDIR");
  }

  private open(path: string, flags: number, mode = 0o666): number {
    let { node } = this.walk(path, true);
    if (node && flags & O_CREAT && flags & O_EXCL) fail("EEXIST");
    if (!node) {
      if (!(flags & O_CREAT)) fail("ENOENT");
      node = this.add(path, S_IFREG | (mode & 0o7777));
    }
    const writing = (flags & O_ACCMODE) !== 0;
    if (this.isDir(node) && writing) fail("EISDIR");
    if (writing && flags & O_TRUNC) this.resize(node, 0);
    const fd = this.nextFd++;
    this.fds.set(fd, { node, flags });
    return fd;
  }

  private write(fd: number, bytes: Uint8Array, position: number): number {
    const { node, flags } = this.fd(fd);
    if ((flags & O_ACCMODE) === 0) fail("EBADF");
    const at = flags & O_APPEND ? node.size! : position;
    if (at + bytes.length > node.size!) this.resize(node, at + bytes.length);
    node.data!.set(bytes, at);
    node.mtime = node.ctime = Date.now();
    return bytes.length;
  }

  private unlink(path: string) {
    const { node, parent, name } = this.walk(path, false);
    if (!node) fail("ENOENT");
    if (this.isDir(node!)) fail("EISDIR");
    parent.children!.delete(name);
    parent.mtime = Date.now();
  }

  private rmdir(path: string) {
    const { node, parent, name } = this.walk(path, false);
    if (!node) fail("ENOENT");
    if (!this.isDir(node!)) fail("ENOTDIR");
    if (node!.children!.size) fail("ENOTEMPTY");
    if (node === this.root) fail("EBUSY");
    parent.children!.delete(name);
    parent.mtime = Date.now();
  }

  private rename(from: string, to: string) {
    const a = this.walk(from, false);
    if (!a.node) fail("ENOENT");
    const b = this.walk(to, false);
    if (!this.isDir(b.parent)) fail("ENOTDIR");
    if (b.node === a.node) return;
    if (b.node) {
      if (this.isDir(a.node!) !== this.isDir(b.node)) fail(this.isDir(b.node) ? "EISDIR" : "ENOTDIR");
      if (this.isDir(b.node) && b.node.children!.size) fail("ENOTEMPTY");
    }
    // Not into itself.
    if (this.isDir(a.node!) && `${to}/`.startsWith(`${from.replace(/\/+$/, "")}/`)) fail("EINVAL");
    a.parent.children!.delete(a.name);
    b.parent.children!.set(b.name, a.node!);
    a.parent.mtime = b.parent.mtime = Date.now();
  }

  mkdirp(path: string) {
    let at = "";
    for (const part of path.split("/").filter(Boolean)) {
      at += "/" + part;
      const n = this.walk(at, true).node;
      if (!n) this.add(at, S_IFDIR | 0o755);
      else if (!this.isDir(n)) fail("ENOTDIR");
    }
  }

  writeFile(path: string, data: Uint8Array, mode = 0o644) {
    const fd = this.open(path, 0o1 | O_CREAT | O_TRUNC, mode);
    this.write(fd, data, 0);
    this.fds.delete(fd);
  }

  readFile(path: string): Uint8Array {
    const n = this.get(path);
    if (this.isDir(n)) fail("EISDIR");
    return n.data!.slice(0, n.size);
  }

  // ---- isomorphic-git's fs (its "promise" form).

  get promises() {
    const statOf = (n: Node) => {
      const [mode, size, mtimeMs, , ctimeMs, , uid, gid, dev] = this.stat(n);
      const type = mode & S_IFMT;
      return {
        mode, size, ino: n.ino, uid, gid, dev, mtimeMs, ctimeMs,
        mtime: new Date(mtimeMs), ctime: new Date(ctimeMs),
        isFile: () => type === S_IFREG,
        isDirectory: () => type === S_IFDIR,
        isSymbolicLink: () => type === S_IFLNK,
      };
    };
    const text = new TextEncoder();
    const run = <T>(fn: () => T) => {
      try {
        return Promise.resolve(fn());
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return {
      readFile: (path: string, opts?: { encoding?: string } | string) =>
        run(() => {
          const bytes = this.readFile(path);
          const encoding = typeof opts === "string" ? opts : opts?.encoding;
          return encoding ? new TextDecoder().decode(bytes) : bytes;
        }),
      writeFile: (path: string, data: Uint8Array | string, opts?: { mode?: number }) =>
        run(() => this.writeFile(path, typeof data === "string" ? text.encode(data) : data, opts?.mode)),
      unlink: (path: string) => run(() => this.unlink(path)),
      readdir: (path: string) => run(() => this.readdir(path)),
      mkdir: (path: string, opts?: { mode?: number } | number) =>
        run(() => void this.add(path, S_IFDIR | ((typeof opts === "number" ? opts : opts?.mode) ?? 0o755))),
      rmdir: (path: string) => run(() => this.rmdir(path)),
      stat: (path: string) => run(() => statOf(this.get(path))),
      lstat: (path: string) => run(() => statOf(this.get(path, false))),
      readlink: (path: string) => run(() => this.op("readlink", [path]) as string),
      symlink: (target: string, path: string) => run(() => void this.op("symlink", [target, path])),
      chmod: (path: string, mode: number) => run(() => void this.op("chmod", [path, mode])),
    };
  }
}
