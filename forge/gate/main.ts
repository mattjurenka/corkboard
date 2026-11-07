// The forge gate as a service: Caddy sends git.corkboard.fyi here, and this
// sends on to Forgejo (gate.ts).
//
//   GATE_ORIGIN       https://git.corkboard.fyi
//   GATE_PORT         where to listen on 127.0.0.1 (default 3001)
//   FORGEJO_URL       http://127.0.0.1:3000, or http://forgejo with FORGEJO_SOCKET
//   FORGEJO_SOCKET    Forgejo's unix socket, if it listens on one
//   GATE_USER_HEADER  Forgejo's REVERSE_PROXY_AUTHENTICATION_USER
//   GATE_CORS         origins allowed to call it from a page, comma-separated
//   GATE_DB           where to keep bindings and revocations

import { createGate } from "./gate";
import { Store } from "./store";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is unset`);
  return v;
};

const gate = createGate({
  origin: env("GATE_ORIGIN"),
  upstream: env("FORGEJO_URL", "http://127.0.0.1:3000"),
  unix: process.env.FORGEJO_SOCKET,
  userHeader: env("GATE_USER_HEADER"),
  corsOrigins: env("GATE_CORS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  store: new Store(env("GATE_DB", "/var/lib/forge-gate/gate.db")),
});

const server = Bun.serve({ hostname: "127.0.0.1", port: Number(env("GATE_PORT", "3001")), fetch: gate.fetch, maxRequestBodySize: 2 * 1024 * 1024 * 1024, idleTimeout: 255 });
console.log(`forge gate on ${server.url}`);
