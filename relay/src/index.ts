// A relay of your own: the encrypted accounts' routes (routes.ts) and
// nothing else. It stores and forwards ciphertext; your devices and your
// node (corkboard-bridge serve) hold the keys. See README.md. /n/<handle>/…
// is the tunnel to an account's nodes (nodes.ts).
//
// Accounts are made with RELAY_INVITE, a secret you set and give to whoever
// may have one here (a creation names it as its invite). Without it, nobody
// can make an account.

import { RelayAccounts } from "./accounts";
import type { Log } from "./log";
import type { Mailbox } from "./mailbox";
import { e2ee, tunnel, type RelayEnv } from "./routes";

export { Log } from "./log";
export { Mailbox } from "./mailbox";
export { Nodes } from "./nodes";

export type Env = RelayEnv & {
  LOG: DurableObjectNamespace<Log>;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  // One object for the relay (named "accounts").
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  RELAY_INVITE?: string;
};

export class Accounts extends RelayAccounts {
  protected admit(invite: string | null) {
    const want = (this.env as Env).RELAY_INVITE;
    if (!invite) return "missing" as const;
    if (!want) return "unknown" as const;
    const [a, b] = [new TextEncoder().encode(invite), new TextEncoder().encode(want)];
    return a.length === b.length && crypto.subtle.timingSafeEqual(a, b) ? { code: "RELAY_INVITE" } : ("unknown" as const);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    const t = await tunnel(request, env);
    if (t) return t;
    if (!path.startsWith("/e2ee/")) return Response.json({ error: "not found" }, { status: 404 });
    return e2ee(request, env, env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")));
  },
} satisfies ExportedHandler<Env>;
