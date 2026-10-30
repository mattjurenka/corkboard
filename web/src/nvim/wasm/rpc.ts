// Rpc (../rpc.js) for a page that runs Neovim itself (?wasm): Neovim in a
// worker (worker.ts), spoken to in msgpack over the ring buffer and its
// output, and the bridge's socket for what is the bridge's (bridge/wasm.ts):
//
//   from Neovim, the bridge's notifications (cloud boards, away mode,
//   windows) go to the bridge; the rest are the page's, as from Rpc
//   from the bridge, [9, msg] is for Neovim, [10, tag, method, params] a
//   hook's request that wants its answer back, and the rest the page's
//
// EphemeralRpc is the same Neovim for a page with no bridge (?wasm=
// ephemeral): its machine is another worker (machine/machine.ts), holding
// a clone of the repository in memory.

import { decode, decodeMultiStream, encode, ExtensionCodec } from "@msgpack/msgpack";
import { replyBuffer } from "./machine/link";
import { InputRing } from "./ring.js";
import type { Start } from "./worker";

// Neovim's Buffer, Window and Tabpage, as {__ext, id}, as the bridge has them.
const extensionCodec = new ExtensionCodec();
for (const type of [0, 1, 2]) {
  extensionCodec.register({
    type,
    encode: (obj: any) => (obj?.__ext === type ? encode(obj.id) : null),
    decode: (data: Uint8Array) => ({ __ext: type, id: decode(data) }),
  });
}

// What Neovim says that is the bridge's (fromNvim in server.ts); the
// context is the page's too.
const FOR_BRIDGE = new Set(["corkboard.cloud", "corkboard.away", "corkboard.open"]);
// What the page says that is the bridge's.
const PAGE_FOR_BRIDGE = new Set(["corkboard.away", "corkboard.window"]);

// Bytes the bridge sent in JSON.
const revive = (_key: string, value: any) =>
  value && typeof value === "object" && typeof value.$b === "string" && Object.keys(value).length === 1
    ? Uint8Array.from(atob(value.$b), (c) => c.charCodeAt(0))
    : value;

type Handler = (params: any) => void;

// corkboard.host, from startWasm in bridge/server.ts.
type Host = {
  id: string;
  cwd: string;
  mounts: string[];
  seeds: Record<string, [string | null, number[] | null]>;
  env: Record<string, string>;
  args: string[];
  wasm: string;
  snapshot: string | null;
};

// Neovim in its worker (worker.ts): msgpack-RPC over the ring buffer and
// its output.
class WasmNvim {
  protected ring = new InputRing();
  // Counts what the machine has told of (a process's output or end, a file
  // changing), which could have changed its files: the worker forgets what
  // it knew of them when it moves.
  protected generation = new Int32Array(new SharedArrayBuffer(4));
  protected worker?: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  protected handlers = new Map<string, Handler>();
  private output?: ReadableStreamDefaultController<Uint8Array>;

  on(method: string, fn: Handler) {
    this.handlers.set(method, fn);
  }

  request(method: string, ...params: unknown[]): Promise<any> {
    const id = this.nextId++;
    this.write([0, id, method, params]);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, ...params: unknown[]) {
    this.write([2, method, params]);
  }

  protected write(msg: unknown) {
    this.ring.write(encode(msg, { extensionCodec }));
  }

  // Neovim's worker, started; ended(why) when Neovim is.
  protected launch(start: Start, transfer: Transferable[], ended: (why: string) => void) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "classic" });
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (this.output = c) });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "out") this.output!.enqueue(data.data);
      else if (data.type === "exit") ended("nvim exited");
      else if (data.type === "abort") {
        console.error("nvim aborted:", data.what);
        ended(`nvim aborted: ${data.what}`.slice(0, 120));
      }
    };
    this.receive(stream);
    this.worker.postMessage(start, transfer);
  }

  // A notification from Neovim: true when it isn't the page's.
  protected forward(_msg: unknown[]): boolean {
    return false;
  }

  private async receive(stream: ReadableStream<Uint8Array>) {
    try {
      for await (const msg of decodeMultiStream(stream, { extensionCodec }) as AsyncIterable<any[]>) {
        if (msg[0] === 1) {
          const [, id, err, result] = msg;
          const p = this.pending.get(id);
          this.pending.delete(id);
          if (err) p?.reject(err);
          else p?.resolve(result);
        } else if (msg[0] === 2) {
          if (!this.forward(msg)) this.handlers.get(msg[1])?.(msg[2]);
        } else if (msg[0] === 0) {
          // Neovim asking us something (rpcrequest); nothing answers yet.
          this.write([1, msg[1], "no handler", null]);
        }
      }
    } catch (err) {
      console.error("nvim stream:", err);
    }
  }
}

export class WasmRpc extends WasmNvim {
  ws: WebSocket;
  ready: Promise<unknown>;

  constructor(url: URL, protocols: string[], private token: string | null) {
    super();
    this.ws = new WebSocket(url, protocols);
    let started: (v: unknown) => void;
    let failed: (e: unknown) => void;
    this.ready = new Promise((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    this.ws.onerror = (e) => failed(e);
    this.ws.onclose = (e) => {
      this.worker?.terminate();
      this.handlers.get("close")?.(e);
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data, revive);
      if (msg[0] === 9 || msg[0] === 10) Atomics.add(this.generation, 0, 1);
      if (msg[0] === 2 && msg[1] === "corkboard.host") {
        this.start(msg[2][0]);
        started(undefined);
      } else if (msg[0] === 9) this.write(msg[1]);
      else if (msg[0] === 10) {
        const [, tag, method, params] = msg;
        if (tag === null) return this.write([2, method, params]);
        this.request(method, ...params).then(
          (result) => this.ws.send(JSON.stringify([10, tag, null, result ?? null])),
          (err) => this.ws.send(JSON.stringify([10, tag, err, null])),
        );
      } else if (msg[0] === 2) this.handlers.get(msg[1])?.(msg[2]);
    };
  }

  notify(method: string, ...params: unknown[]) {
    if (PAGE_FOR_BRIDGE.has(method)) this.ws.send(JSON.stringify([2, method, params]));
    else super.notify(method, ...params);
  }

  protected forward(msg: unknown[]) {
    const method = msg[1] as string;
    if (FOR_BRIDGE.has(method) || method === "corkboard.context") this.ws.send(JSON.stringify(msg));
    return FOR_BRIDGE.has(method);
  }

  private async start(host: Host) {
    const base = new URL(".", location.href).href;
    // The store's part of the runtimepath, kept by the browser after the
    // first time (it never changes at that URL).
    let snapshot: Uint8Array | null = null;
    if (host.snapshot) {
      try {
        const res = await fetch(new URL(host.snapshot, base), { headers: this.token ? { "x-corkboard-token": this.token } : {} });
        if (res.ok) snapshot = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        console.error("snapshot:", err);
      }
    }
    const start: Start = {
      type: "start",
      inputBuffer: this.ring.buffer,
      base,
      wasm: host.wasm,
      snapshot,
      generation: this.generation.buffer as SharedArrayBuffer,
      session: host.id,
      token: this.token,
      args: host.args,
      env: host.env,
      cwd: host.cwd,
      mounts: host.mounts,
      seeds: host.seeds,
    };
    this.launch(start, snapshot ? [snapshot.buffer] : [], (why) => this.ws.close(1000, why));
  }
}

// What a page with no machine starts from (bridge/server.ts /wasm/manifest,
// and the Worker's when it serves the page): where Neovim is, and the
// plugins' files (wasm.bundle), with their names in runtimepath order.
type Manifest = { wasm: string; plugins: string; rtp: string[] };

// A repository on Forgejo, and the headers git's requests for it need.
export type Repo = { owner: string; name: string; ref?: string; headers: Record<string, string> };

export class EphemeralRpc extends WasmNvim {
  ready: Promise<unknown>;
  private machine = new Worker(new URL("./machine/machine.ts", import.meta.url), { type: "module" });
  private asks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private nextAsk = 1;

  constructor(repo: Repo, token: string | null) {
    super();
    this.machine.onmessage = ({ data }) => {
      if (data.type === "progress") return this.handlers.get("corkboard.clone")?.([data]);
      // A process's output or end, for corkboard.wasm, as the bridge sends them.
      if (data.type === "event") return this.notify("nvim_exec_lua", "require('corkboard.wasm').event(...)", data.args);
      const ask = this.asks.get(data.id);
      this.asks.delete(data.id);
      if (data.type === "done") ask?.resolve();
      else ask?.reject(new Error(data.error));
    };
    this.ready = this.start(repo, token);
  }

  private ask(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
    const id = this.nextAsk++;
    this.machine.postMessage({ ...msg, id }, transfer);
    return new Promise((resolve, reject) => this.asks.set(id, { resolve, reject }));
  }

  private async start(repo: Repo, token: string | null) {
    const base = new URL(".", location.href).href;
    const headers: Record<string, string> = token ? { "x-corkboard-token": token } : {};
    const manifest = (await (await fetch(new URL("wasm/manifest", base), { headers })).json()) as Manifest;
    const bundle = new Uint8Array(await (await fetch(new URL(manifest.plugins, base), { headers })).arrayBuffer());
    const dir = `/work/${repo.name}`;
    await Promise.all([
      this.ask({ type: "load", bundle }, [bundle.buffer]),
      this.ask({ type: "clone", url: new URL(`api/git/repos/${repo.owner}/${repo.name}`, base).href, dir, ref: repo.ref, headers: repo.headers }),
    ]);
    const link = new MessageChannel();
    const reply = replyBuffer();
    this.machine.postMessage({ type: "link", port: link.port1, reply }, [link.port1]);
    const rtp = manifest.rtp.map((n) => `/plugins/${n}`).join(",");
    const start: Start = {
      type: "start",
      inputBuffer: this.ring.buffer,
      base,
      wasm: manifest.wasm,
      snapshot: null,
      generation: this.generation.buffer as SharedArrayBuffer,
      session: "",
      token: null,
      args: ["--cmd", `set rtp^=${rtp}`, "--cmd", "let g:corkboard_wasm = 1 | let g:corkboard_ephemeral = 1"],
      env: { LANG: "en_US.UTF-8" },
      cwd: dir,
      mounts: ["/work", "/plugins"],
      seeds: {},
      machine: { port: link.port2, reply },
    };
    this.launch(start, [link.port2], (why) => this.handlers.get("close")?.({ code: 1000, reason: why }));
  }
}
