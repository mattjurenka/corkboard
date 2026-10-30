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
import { Cloud, Session as CloudSession, USER, type Link } from "../../../../bridge/cloud-session";
import * as cloud from "../../cloud";
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
// cloud: the page's own origin is the Worker, which it signs in to
// (../../cloud.ts) for its boards and its clone.
type Manifest = { wasm: string; plugins: string; rtp: string[]; cloud?: boolean };

// What to open: a board (its repository is its remote on Forgejo), or a
// Forgejo repository itself. token: the bridge's, when a bridge serves the page.
export type Opening = { board?: string; repo?: { owner: string; name: string; ref?: string }; token: string | null };

// The repository a remote names on Forgejo's host: owner and name, or none.
function onForgejo(remote: string, host: string) {
  const scp = remote.match(/^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (scp) return scp[1] === host ? { owner: scp[2], name: scp[3] } : undefined;
  const url = URL.parse(remote);
  const m = url?.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return url?.hostname === host && m ? { owner: m[1], name: m[2] } : undefined;
}

// Neovim's cloud requests (corkboard.cloud: cards, plans, the fleet), which
// the bridge answers for a page that has one (bridge/boards.ts), answered
// here with the same code, straight to the Worker.
const pageLink: Link = {
  cloud: location.origin,
  token: () => cloud.token(),
  socket: cloud.socket,
  environment: null,
  remotes: async () => [],
  machine: () => null,
  self: () => undefined,
};

export class EphemeralRpc extends WasmNvim {
  ready: Promise<unknown>;
  private machine = new Worker(new URL("./machine/machine.ts", import.meta.url), { type: "module" });
  private asks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private nextAsk = 1;
  private cloud?: CloudSession;

  constructor(open: Opening) {
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
    this.ready = this.start(open);
  }

  // What the bridge would have taken: the cloud's requests are answered
  // here; away mode and other windows are a machine's, and there's none.
  protected forward(msg: unknown[]) {
    if (msg[1] === "corkboard.cloud") {
      this.cloudCall(msg[2] as unknown[]);
      return true;
    }
    return msg[1] === "corkboard.away" || msg[1] === "corkboard.open";
  }

  private cloudCall([id, op, ...args]: unknown[]) {
    const answer = (a: object) => this.notify("nvim_exec_lua", "require('corkboard.cards.cloud').answer(...)", [{ id, ...a }]);
    if (!this.cloud) return answer({ error: "corkboard cloud: this page isn't signed in to it" });
    this.cloud.call(op as string, args).then(
      (result) => answer({ result: result ?? null }),
      (err) => answer({ error: (err as Error).message }),
    );
  }

  private ask(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
    const id = this.nextAsk++;
    this.machine.postMessage({ ...msg, id }, transfer);
    return new Promise((resolve, reject) => this.asks.set(id, { resolve, reject }));
  }

  // The repository of a board: its remote on Forgejo.
  private async repoOf(key: string) {
    const [boards, git] = await Promise.all([cloud.api<{ key: string; remotes?: string[] }[]>("/api/boards"), cloud.api<{ origin: string }>("/api/git")]);
    const board = boards.find((b) => b.key === key);
    if (!board) throw new Error(`no board ${key}`);
    const host = new URL(git.origin).hostname;
    for (const r of board.remotes ?? []) {
      const repo = onForgejo(r, host);
      if (repo) return repo;
    }
    throw new Error(`board ${key} has no repository on ${host}`);
  }

  private async start(open: Opening) {
    const base = new URL(".", location.href).href;
    const headers: Record<string, string> = open.token ? { "x-corkboard-token": open.token } : {};
    const manifest = (await (await fetch(new URL("wasm/manifest", base), { headers })).json()) as Manifest;
    const bundle = fetch(new URL(manifest.plugins, base), { headers }).then(async (r) => new Uint8Array(await r.arrayBuffer()));
    if (manifest.cloud) {
      this.cloud = new CloudSession(new Cloud(pageLink), (key, event) =>
        key === USER
          ? // The day plan's window follows it for the plan, a project's for the fleet view.
            this.notify("nvim_exec_lua", "require(require('corkboard').window == 'plan' and 'corkboard.plan' or 'corkboard.fleet').cloud_event(...)", [event])
          : this.notify("nvim_exec_lua", "require('corkboard.cards').cloud_event(...)", [key, event]),
      );
    }
    const repo = open.repo ?? (open.board && manifest.cloud ? await this.repoOf(open.board) : undefined);
    if (!repo) throw new Error("which repository? ?repo=owner/name, or ?board= on a page the Worker serves");
    // The Worker's git route (cloud/src/git.ts), signed in; a bridge's
    // passes it on with its own sign-in, for its token.
    const git = manifest.cloud ? { Authorization: `Bearer ${await cloud.token()}` } : headers;
    const dir = `/work/${repo.name}`;
    const plugins = await bundle;
    await Promise.all([
      this.ask({ type: "load", bundle: plugins }, [plugins.buffer]),
      this.ask({ type: "clone", url: new URL(`api/git/repos/${repo.owner}/${repo.name}`, location.origin + "/").href, dir, ref: open.repo?.ref, headers: git }),
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
      // The board, named: a shallow clone has no first commit to find it by.
      env: { LANG: "en_US.UTF-8", ...(open.board && { CORKBOARD_BOARD: open.board }) },
      cwd: dir,
      mounts: ["/work", "/plugins"],
      seeds: {},
      machine: { port: link.port2, reply },
    };
    this.launch(start, [link.port2], (why) => this.handlers.get("close")?.({ code: 1000, reason: why }));
  }
}
