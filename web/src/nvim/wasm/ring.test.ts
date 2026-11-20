// Neovim's stdin in the page: the page writes into the ring (ring.js), and
// pre.js's device, inside the worker, reads it out. pre.js is run here as
// emscripten runs it, with a Module, an FS and an ENV that keep what it
// asks of them, over the same SharedArrayBuffer.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { InputRing } from "./ring.js";

const EAGAIN = 6;
const POLLIN = 1;
const POLLOUT = 4;

type Ops = { read?: (s: unknown, b: Uint8Array, o: number, n: number) => number; write?: (s: unknown, b: Uint8Array, o: number, n: number) => number; poll: () => number };

// pre.js over ring's buffer: its two devices, what it posted, and its Module.
function boot(ring: InstanceType<typeof InputRing>, hostSetup?: (x: { FS: unknown; ENV: Record<string, string> }) => void) {
  class ErrnoError extends Error {
    constructor(readonly errno: number) {
      super(`errno ${errno}`);
    }
  }
  const devices = new Map<number, Ops>();
  const nodes = new Map<string, { mode: number; dev: number }>();
  const dirs: string[] = [];
  const FS = {
    ErrnoError,
    makedev: (major: number, minor: number) => (major << 8) | minor,
    registerDevice: (dev: number, ops: Ops) => void devices.set(dev, ops),
    mkdev: (path: string, mode: number, dev: number) => void nodes.set(path, { mode, dev }),
    lookupPath: (path: string) => ({ node: nodes.get(path)! }),
    mkdirTree: (path: string) => void dirs.push(path),
  };
  const ENV: Record<string, string> = {};
  const posted: { msg: { type: string; data?: Uint8Array; code?: number; what?: string }; transfer?: unknown[] }[] = [];
  const postMessage = (msg: (typeof posted)[number]["msg"], transfer?: unknown[]) => void posted.push({ msg, transfer });
  const Module: Record<string, any> = { inputBuffer: ring.buffer, hostSetup };
  const src = readFileSync(new URL("./pre.js", import.meta.url), "utf8");
  new Function("Module", "FS", "ENV", "postMessage", src)(Module, FS, ENV, postMessage);
  for (const run of Module.preRun) run();
  const dev = (name: string) => devices.get(nodes.get(`/dev/${name}`)!.dev)!;
  return { input: dev("ui-in"), output: dev("ui-out"), nodes, dirs, ENV, posted, Module, ErrnoError };
}

// What the device gives a read of up to n bytes, or the errno it throws.
const read = (input: Ops, n: number) => {
  const buf = new Uint8Array(n + 4).fill(0xee);
  try {
    const got = input.read!(null, buf, 2, n);
    expect(buf[0]).toBe(0xee);
    expect(buf[2 + got]).toBe(0xee);
    return [...buf.subarray(2, 2 + got)];
  } catch (e: any) {
    return { errno: e.errno };
  }
};
const bytes = (...xs: number[]) => new Uint8Array(xs);
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the stdin ring", () => {
  test("what the page writes, the worker reads, in order and in pieces", () => {
    const ring = new InputRing(64);
    const { input } = boot(ring);
    expect(input.poll()).toBe(0);
    expect(read(input, 8)).toEqual({ errno: EAGAIN });
    ring.write(bytes(1, 2, 3));
    ring.write(bytes(4, 5));
    expect(input.poll()).toBe(POLLIN);
    expect(read(input, 2)).toEqual([1, 2]);
    expect(read(input, 100)).toEqual([3, 4, 5]);
    expect(input.poll()).toBe(0);
    expect(read(input, 1)).toEqual({ errno: EAGAIN });
  });

  test("round the end of the buffer and back", () => {
    const ring = new InputRing(16);
    const { input } = boot(ring);
    for (let k = 0; k < 20; k++) {
      ring.write(new Uint8Array(range(k * 11, 11)));
      expect(read(input, 16)).toEqual(range(k * 11, 11));
    }
  });

  test("the counters wrap past 2^31", () => {
    const ring = new InputRing(16);
    ring.head[0] = ring.head[1] = 0x7ffffffa;
    const { input } = boot(ring);
    ring.write(new Uint8Array(range(0, 12)));
    expect(input.poll()).toBe(POLLIN);
    expect(read(input, 16)).toEqual(range(0, 12));
    expect(ring.head[0]).toBeLessThan(0);
    expect(input.poll()).toBe(0);
  });

  test("more than fits waits for the worker to read, and none is lost", async () => {
    const ring = new InputRing(16);
    const { input } = boot(ring);
    ring.write(new Uint8Array(range(0, 40)));
    ring.write(new Uint8Array(range(40, 5)));
    expect(ring.pending.length).toBe(2);
    const got: number[] = [];
    for (let i = 0; i < 50 && got.length < 45; i++) {
      const r = read(input, 7);
      if (Array.isArray(r)) got.push(...r);
      else await tick(6);
    }
    expect(got).toEqual(range(0, 45));
    expect(ring.pending).toEqual([]);
  });

  test("uvWait returns at once with input there, and after its timeout without", () => {
    const ring = new InputRing(16);
    const { Module } = boot(ring);
    let t = performance.now();
    Module.uvWait(0);
    ring.write(bytes(1));
    t = performance.now();
    Module.uvWait(1000);
    expect(performance.now() - t).toBeLessThan(50);
    const { input } = boot(ring);
    read(input, 1);
    t = performance.now();
    Module.uvWait(30);
    expect(performance.now() - t).toBeGreaterThanOrEqual(25);
  });
});

describe("pre.js", () => {
  test("stdout goes to the page as a copy it can take", () => {
    const { output, posted } = boot(new InputRing(16));
    const heap = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(output.poll()).toBe(POLLOUT);
    expect(output.write!(null, heap.subarray(1), 1, 3)).toBe(3);
    expect(posted).toHaveLength(1);
    const { msg, transfer } = posted[0];
    expect(msg.type).toBe("out");
    expect([...msg.data!]).toEqual([1, 2, 3]);
    expect(transfer).toEqual([msg.data!.buffer]);
    expect(msg.data!.buffer).not.toBe(heap.buffer);
  });

  test("the devices are FIFOs, so libuv takes them for pipes; Neovim's home and runtime are set; the host's setup runs", () => {
    let setup: { ENV: Record<string, string> } | undefined;
    const { nodes, dirs, ENV } = boot(new InputRing(16), (x) => void (setup = x));
    for (const name of ["/dev/ui-in", "/dev/ui-out"]) expect(nodes.get(name)!.mode).toBe(0o010000 | 0o666);
    expect(dirs).toContain("/home/web");
    expect(ENV).toMatchObject({ HOME: "/home/web", VIMRUNTIME: "/usr/share/nvim/runtime", LANG: "en_US.UTF-8" });
    expect(setup?.ENV).toBe(ENV);
  });

  test("exit and abort are told to the page", () => {
    const { Module, posted } = boot(new InputRing(16));
    Module.onExit(3);
    Module.onAbort(new Error("boom"));
    expect(posted.map((p) => p.msg)).toEqual([
      { type: "exit", code: 3 },
      { type: "abort", what: "Error: boom" },
    ]);
  });
});
