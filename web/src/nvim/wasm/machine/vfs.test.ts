// The page's own filesystem (vfs.ts) against a real disk's, as the bridge's
// /host/fs does it (bridge/wasm.ts): the same ops on both, the same answers,
// or the same error. Neovim's worker mounts either the same way, so where
// they differ, Neovim in a page with no machine sees something a machine
// wouldn't show it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { decode, encode } from "@msgpack/msgpack";
import { type Gen, fuzz } from "../../../../../lib/testing/fuzz";
import { Vfs } from "./vfs";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

// By a path tsc doesn't follow: the page's typecheck leaves the bridge out.
type Host = { fs(body: Uint8Array): Uint8Array; close(): void };
const { Host } = (await import(`${"../../../../../bridge/wasm"}`)) as { Host: new (exec: () => void, request: () => void, env: object) => Host };
const host = new Host(() => {}, () => {}, {});
const roots: string[] = [];
afterAll(() => {
  host.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The disk's answer to an op, as the worker gets it: [error, result].
const disk = (op: string, a: unknown[]) => decode(host.fs(encode([op, ...a]))) as [string | null, unknown];
const mem = (vfs: Vfs, op: string, a: unknown[]): [string | null, unknown] => {
  try {
    return [null, vfs.op(op, a)];
  } catch (err: any) {
    return [err.code ?? "EIO", null];
  }
};

// What both should agree on: a stat's type, and a file's or link's size
// (permissions follow the umask on disk, and times its clock).
const statOf = (s: unknown) => {
  const [mode, size] = s as number[];
  return (mode & S_IFMT) === S_IFDIR ? [mode & S_IFMT] : [mode & S_IFMT, size];
};
function comparable(op: string, r: [string | null, unknown]) {
  const [err, v] = r;
  if (err) return { err };
  switch (op) {
    case "lstat":
    case "fstat":
      return statOf(v);
    case "readdir":
      return [...(v as string[])].sort();
    case "list": {
      const [names, stats] = v as [string[], unknown[]];
      return names.map((n, i) => [n, statOf(stats[i])]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    }
    case "read":
      return [...(v as Uint8Array)];
    case "openread":
      return [...(v as [number, Uint8Array])[1]];
    case "open":
    case "statfs":
      return "ok";
    default:
      return v;
  }
}

// Two of the same filesystem: one on disk under a temp dir, one in memory,
// each path at the same place in it, and fds by the order they were opened.
function pair() {
  const root = mkdtempSync(`${tmpdir()}/vfs-`);
  roots.push(root);
  const vfs = new Vfs();
  const fds: [number, number][] = [];
  const at = (p: string) => (p === "/" ? root : root + p);
  // An op on both, with its paths (in a) and fds (as indexes in fds).
  function run(op: string, a: unknown[], paths: number[] = [], fd = false) {
    const onDisk = a.map((x, i) => (paths.includes(i) ? at(x as string) : x));
    const inMem = [...a];
    if (fd) {
      const f = fds[a[0] as number] ?? [-1, -1];
      onDisk[0] = f[0];
      inMem[0] = f[1];
    }
    const d = disk(op, onDisk);
    const m = mem(vfs, op, inMem);
    if (op === "open" || op === "openread") {
      const df = d[0] ? null : op === "open" ? (d[1] as number) : (d[1] as [number])[0];
      const mf = m[0] ? null : op === "open" ? (m[1] as number) : (m[1] as [number])[0];
      // One opened and the other not is the mismatch itself; close it.
      if (df !== null && mf !== null) fds.push([df, mf]);
      else if (df !== null) disk("close", [df]);
      else if (mf !== null) mem(vfs, "close", [mf]);
    }
    if (op === "close" && fd) fds.splice(a[0] as number, 1);
    // A directory's size is the filesystem's own.
    if (op === "fsize" && !d[0] && statOf(disk("fstat", [onDisk[0]])[1]).length === 1) return { op, args: a, disk: "a directory", mem: "a directory" };
    return { op, args: a, disk: comparable(op, d), mem: comparable(op, m) };
  }
  // Everything is under /w, so a link's .. never climbs out of the temp dir.
  run("mkdir", ["/w", 0o755], [0]);
  const closeAll = () => {
    for (const [d, m] of fds) disk("close", [d]), mem(vfs, "close", [m]);
    fds.length = 0;
  };
  return { run, fds, closeAll };
}

const same = (r: ReturnType<ReturnType<typeof pair>["run"]>) => expect(r.mem).toEqual(r.disk);

describe("vfs as a disk", () => {
  test("files: made, written, read, cut, appended to", () => {
    const fs = pair();
    same(fs.run("mkdir", ["/w/d", 0o755], [0]));
    same(fs.run("open", ["/w/d/f", O_CREAT | O_RDWR, 0o644], [0]));
    same(fs.run("write", [0, new TextEncoder().encode("hello world"), 0], [], true));
    same(fs.run("write", [0, new TextEncoder().encode("HE"), 0], [], true));
    same(fs.run("read", [0, 100, 0], [], true));
    same(fs.run("read", [0, 3, 6], [], true));
    same(fs.run("read", [0, 3, 50], [], true));
    same(fs.run("fsize", [0], [], true));
    same(fs.run("ftruncate", [0, 4], [], true));
    same(fs.run("read", [0, 100, 0], [], true));
    same(fs.run("truncate", ["/w/d/f", 10], [0]));
    same(fs.run("read", [0, 100, 0], [], true));
    same(fs.run("fstat", [0], [], true));
    same(fs.run("close", [0], [], true));
    same(fs.run("open", ["/w/d/f", O_WRONLY | O_APPEND], [0]));
    same(fs.run("write", [0, new Uint8Array([1, 2, 3]), 0], [], true));
    same(fs.run("openread", ["/w/d/f", 0, 64], [0]));
    same(fs.run("open", ["/w/d/f", O_WRONLY | O_TRUNC], [0]));
    same(fs.run("lstat", ["/w/d/f"], [0]));
    fs.closeAll();
  });

  test("directories and links", () => {
    const fs = pair();
    same(fs.run("mkdir", ["/w/a", 0o755], [0]));
    same(fs.run("mkdir", ["/w/a", 0o755], [0]));
    same(fs.run("mkfile", ["/w/a/f", 0o644], [0]));
    same(fs.run("mkfile", ["/w/a/f", 0o644], [0]));
    same(fs.run("symlink", ["f", "/w/a/l"], [1]));
    same(fs.run("symlink", ["../a", "/w/b"], [1]));
    same(fs.run("readlink", ["/w/a/l"], [0]));
    same(fs.run("readlink", ["/w/a/f"], [0]));
    same(fs.run("lstat", ["/w/a/l"], [0]));
    same(fs.run("lstat", ["/w/b/f"], [0]));
    same(fs.run("list", ["/w/a"], [0]));
    same(fs.run("list", ["/w/b"], [0]));
    same(fs.run("readdir", ["/w/a/f"], [0]));
    same(fs.run("rmdir", ["/w/a"], [0]));
    same(fs.run("unlink", ["/w/a"], [0]));
    same(fs.run("rename", ["/w/a/f", "/w/a/g"], [0, 1]));
    same(fs.run("rename", ["/w/a", "/w/a/c"], [0, 1]));
    same(fs.run("unlink", ["/w/a/g"], [0]));
    same(fs.run("unlink", ["/w/a/l"], [0]));
    same(fs.run("rmdir", ["/w/a"], [0]));
    same(fs.run("lstat", ["/w/b/f"], [0]));
    same(fs.run("readdir", ["/w"], [0]));
  });
});

// What the fuzz below found vfs doing otherwise.
describe("vfs as a disk, where it wasn't", () => {
  test("a directory moved into itself by a path with .. in it is refused, not cut off in a loop", () => {
    const fs = pair();
    same(fs.run("mkdir", ["/w/c", 0o755], [0]));
    same(fs.run("rename", ["/w/c/../c", "/w/c/l"], [0, 1]));
    same(fs.run("readdir", ["/w"], [0]));
    // Nor a file over the directory it's in.
    same(fs.run("mkfile", ["/w/c/f", 0o644], [0]));
    same(fs.run("rename", ["/w/c/f", "/w/c"], [0, 1]));
  });

  test("O_CREAT through a dangling link makes the file it leads to; O_EXCL takes the link as there", () => {
    const fs = pair();
    same(fs.run("symlink", ["f", "/w/l"], [1]));
    same(fs.run("open", ["/w/l", O_WRONLY | O_CREAT | O_EXCL, 0o644], [0]));
    same(fs.run("open", ["/w/l", O_WRONLY | O_CREAT, 0o644], [0]));
    same(fs.run("lstat", ["/w/f"], [0]));
    same(fs.run("symlink", ["a/f", "/w/m"], [1]));
    same(fs.run("open", ["/w/m", O_WRONLY | O_CREAT, 0o644], [0]));
    same(fs.run("open", ["/w/m", O_WRONLY | O_CREAT | O_EXCL, 0o644], [0]));
    fs.closeAll();
  });

  test("an fd only does what it was opened for", () => {
    const fs = pair();
    same(fs.run("open", ["/w/f", O_WRONLY | O_CREAT, 0o644], [0]));
    same(fs.run("write", [0, new Uint8Array([1, 2]), 0], [], true));
    same(fs.run("read", [0, 10, 0], [], true));
    same(fs.run("open", ["/w/f", 0], [0]));
    same(fs.run("ftruncate", [1, 0], [], true));
    same(fs.run("write", [1, new Uint8Array([1]), 0], [], true));
    same(fs.run("open", ["/w", 0], [0]));
    same(fs.run("ftruncate", [2, 0], [], true));
    fs.closeAll();
  });

  test("a file isn't a directory on the way to .., and writing nothing past the end grows nothing", () => {
    const fs = pair();
    same(fs.run("mkfile", ["/w/f", 0o644], [0]));
    same(fs.run("readdir", ["/w/f/.."], [0]));
    same(fs.run("lstat", ["/w/f/../f"], [0]));
    same(fs.run("rename", ["/w/nothing", "/w/f/x"], [0, 1]));
    same(fs.run("open", ["/w/f", O_RDWR], [0]));
    same(fs.run("write", [0, new Uint8Array(0), 14], [], true));
    same(fs.run("fstat", [0], [], true));
    fs.closeAll();
  });
});

// Paths in a small tree under /w, so ops run into each other; links only
// relative and a .. at most, so they never lead above /w's parent, which
// is / in memory and the temp dir on disk.
const NAMES = ["a", "b", "c", "f", "l"];
const path = (g: Gen) => {
  const parts = Array.from({ length: g.int(1, 3) }, () => g.pick(NAMES));
  if (parts.length > 1 && g.bool(0.1)) parts.splice(g.int(1, parts.length - 1), 0, "..");
  return "/w/" + parts.join("/");
};
const target = (g: Gen) => g.pick(["f", "a", "../f", "../a", "a/f", "b", "l", "."]);
const FLAGS = [0, O_WRONLY, O_RDWR, O_WRONLY | O_CREAT, O_RDWR | O_CREAT | O_TRUNC, O_WRONLY | O_CREAT | O_EXCL, O_WRONLY | O_APPEND, O_RDWR | O_APPEND | O_CREAT];

function step(g: Gen, fs: ReturnType<typeof pair>) {
  const fd = () => g.int(0, Math.max(0, fs.fds.length - 1));
  const hasFd = fs.fds.length > 0;
  switch (g.int(0, hasFd ? 18 : 12)) {
    case 0: return fs.run("mkdir", [path(g), 0o755], [0]);
    case 1: return fs.run("mkfile", [path(g), 0o644], [0]);
    case 2: return fs.run("symlink", [target(g), path(g)], [1]);
    case 3: return fs.run("rename", [path(g), path(g)], [0, 1]);
    case 4: return fs.run("unlink", [path(g)], [0]);
    case 5: return fs.run("rmdir", [path(g)], [0]);
    case 6: return fs.run("lstat", [path(g)], [0]);
    case 7: return fs.run("readdir", [path(g)], [0]);
    case 8: return fs.run("list", [path(g)], [0]);
    case 9: return fs.run("readlink", [path(g)], [0]);
    case 10: return fs.run("open", [path(g), g.pick(FLAGS), 0o644], [0]);
    case 11: return fs.run("truncate", [path(g), g.int(0, 40)], [0]);
    case 12: return fs.run("openread", [path(g), 0, g.int(0, 40)], [0]);
    case 13: return fs.run("write", [fd(), g.bytes(24), g.int(0, 30)], [], true);
    // Of at least a byte: node answers a read of none without asking.
    case 14: return fs.run("read", [fd(), g.int(1, 40), g.int(0, 30)], [], true);
    case 15: return fs.run("fstat", [fd()], [], true);
    case 16: return fs.run("fsize", [fd()], [], true);
    case 17: return fs.run("ftruncate", [fd(), g.int(0, 40)], [], true);
    default: return fs.run("close", [fd()], [], true);
  }
}

fuzz("vfs answers as the disk does", (g) => {
  const fs = pair();
  const done: unknown[] = [];
  try {
    for (let n = g.int(1, 40); n > 0; n--) {
      const r = step(g, fs);
      done.push([r.op, r.args.map((x) => (x instanceof Uint8Array ? `${x.length} bytes` : x))]);
      if (!Bun.deepEquals(r.mem, r.disk)) throw new Error(`after ${JSON.stringify(done)}:\n  disk ${JSON.stringify(r.disk)}\n  vfs  ${JSON.stringify(r.mem)}`);
    }
  } finally {
    fs.closeAll();
  }
}, { runs: 300 });
