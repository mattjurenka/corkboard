// The relay (relay/src) served by Bun, for tests that need a real one over
// HTTP from another process (the bridge's CLI): its Durable Objects run
// in this process, each one object per name, on SQLite in memory, as
// workerd would run them but with no sockets of their own (a follow or a
// tunnel isn't served). The Worker's own tests (relay/test) run it in
// workerd; this is for the clients'.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

// ctx.storage.sql's exec: a cursor of rows, which CF gives blobs in as
// ArrayBuffers.
function sqlStorage(db: Database) {
  const blob = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const unblob = (row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = (row[k] as Uint8Array).slice().buffer; // keys: a row's own columns
    return row;
  };
  return {
    exec(query: string, ...args: unknown[]) {
      // A schema: several statements, no bindings.
      if (!args.length && query.trim().replace(/;\s*$/, "").includes(";")) {
        db.run(query);
        return cursor([]);
      }
      return cursor((db.query(query).all(...(args.map(blob) as SQLQueryBindings[])) as Record<string, unknown>[]).map(unblob));
    },
  };
}

function cursor(rows: Record<string, unknown>[]) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
      return rows[0];
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

function state() {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  return {
    storage: {
      sql: sqlStorage(db),
      transactionSync: <T>(f: () => T) => db.transaction(f)(),
      get: async (k: string) => structuredClone(kv.get(k)),
      put: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
      deleteAll: async () => kv.clear(),
      setAlarm: async () => {},
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {
      throw new Error("the Bun relay serves no sockets");
    },
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null,
    blockConcurrencyWhile: <T>(f: () => Promise<T>) => f(),
  };
}

// A namespace: one object per name, made when first asked for.
function namespace(make: (ctx: ReturnType<typeof state>) => object) {
  const objects = new Map<string, object>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let o = objects.get(id);
      if (!o) objects.set(id, (o = make(state())));
      return o;
    },
  };
}

// R2, as much as the relay's blobs use.
function bucket() {
  const blobs = new Map<string, Uint8Array>();
  const body = (v: Uint8Array) => ({ body: new Response(v.slice()).body, size: v.length, arrayBuffer: async () => v.slice().buffer });
  return {
    get: async (k: string) => (blobs.has(k) ? body(blobs.get(k)!) : null),
    head: async (k: string) => (blobs.has(k) ? { size: blobs.get(k)!.length } : null),
    put: async (k: string, v: ArrayBuffer | Uint8Array | string) => void blobs.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v)),
    delete: async (k: string) => void blobs.delete(k),
  };
}

let shimmed = false;
function shim() {
  if (shimmed) return;
  shimmed = true;
  class DurableObject {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  }
  Bun.plugin({
    name: "cloudflare:workers",
    setup(b) {
      b.module("cloudflare:workers", () => ({ exports: { DurableObject, env: {}, exports: {} }, loader: "object" }));
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.WebSocketRequestResponsePair ??= class {};
  // workerd's.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  subtle.timingSafeEqual ??= (a, b) => a.byteLength === b.byteLength && timingSafeEqual(a as Uint8Array, b as Uint8Array);
}

// A relay on a port of its own, with invite as its RELAY_INVITE.
export async function serveRelay(invite = "invite-for-tests") {
  shim();
  const src = join(import.meta.dir, "../../relay/src/index.ts");
  const m = (await import(src)) as { default: { fetch(r: Request, env: unknown): Promise<Response> }; Log: any; Mailbox: any; Accounts: any; Nodes: any };
  const env: Record<string, unknown> = { RELAY_INVITE: invite, MEDIA: bucket() };
  env.LOG = namespace((ctx) => new m.Log(ctx, env));
  env.MAILBOX = namespace((ctx) => new m.Mailbox(ctx, env));
  env.ACCOUNTS = namespace((ctx) => new m.Accounts(ctx, env));
  env.NODES = namespace((ctx) => new m.Nodes(ctx, env));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => m.default.fetch(req, env) });
  env.ORIGIN = `http://127.0.0.1:${server.port}`;
  return { origin: env.ORIGIN as string, invite, stop: () => server.stop(true) };
}
