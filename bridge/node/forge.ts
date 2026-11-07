// The account's forge on the node (.agent/plans/forge-on-leader.md, pieces
// 1 and 2): Forgejo's requests on sealed channels, under /forge/, let in as
// the account's Forgejo user. The channel has shown who the peer is, so a
// full device of the account is the account, with nothing more to show. A
// relay-only one (fleetd's) holds a grant, and shows the chain in
// x-corkboard-chain (base64url JSON, a Chain whose holder is the channel's
// device) on each request, checked as the hosted gate checks a session's
// (forge/gate/proxy.ts): its repos, permissions and refs.
//
// What goes with the forge when the leader moves is in the account's fleet
// object (fleet.ts), so a new leader has it from the start:
//
//   forge                  user: the account's Forgejo login
//   revoked:<hash>:<by>    statement: a grant taken back (a GrantRevocation)

import { type Chain, type GrantRevocation, type Revoked, checkChain, checkGrantRevocation } from "../../lib/e2ee/forge";
import { type DeviceCert, type Revocation, type Signed, fromB64url, fromUtf8 } from "../../lib/e2ee/wire";
import { forgeProxy, type Upstream } from "../../forge/gate/proxy";
import { FLEET, SEP } from "./objects";
import type { Replicas } from "./replicas";

export const CHAIN_HEADER = "x-corkboard-chain";
export const FORGE_RECORD = "forge";
export const revokedRecord = (hash: string, by: string) => `revoked${SEP}${hash}${SEP}${by}`;
const REVOKED_PREFIX = `revoked${SEP}`;
// How long the relay's revocations are gone by before asking again (as relay.ts's).
const REVOKED_MS = 60_000;

const error = (status: number, message: string) => Response.json({ error: message }, { status });

// The forge's records in the fleet object.
export class ForgeRecords {
  constructor(private replicas: Replicas) {}

  private cards() {
    return this.replicas.get("fleet", FLEET)?.cards().filter((c) => !c.deleted) ?? [];
  }

  user(): string | undefined {
    const u = this.cards().find((c) => c.id === FORGE_RECORD)?.user;
    return typeof u === "string" && /^[\w.-]{1,40}$/.test(u) ? u : undefined;
  }

  setUser(user: string) {
    return this.replicas.change("fleet", FLEET, { t: "card", card: FORGE_RECORD, set: { user } });
  }

  // Who has revoked the grant with this hash, by the statements kept (each
  // checked: a record is only as good as its signature).
  revokedBy(hash: string): string[] {
    const prefix = `${REVOKED_PREFIX}${hash}${SEP}`;
    return this.cards().flatMap((c) => {
      if (!c.id.startsWith(prefix)) return [];
      const r = c.statement as Signed<GrantRevocation> | undefined;
      return r && !checkGrantRevocation(r) && r.body.grant === hash ? [r.body.by] : [];
    });
  }

  revoke(r: Signed<GrantRevocation>) {
    return this.replicas.change("fleet", FLEET, { t: "card", card: revokedRecord(r.body.grant, r.body.by), set: { statement: r } });
  }
}

export type ForgeConfig = Upstream & {
  records: Pick<ForgeRecords, "user" | "revokedBy">;
  // The account's id, and its key now (what its devices' certs are signed by).
  account: () => { id: string; key: string } | undefined;
  // The account's device revocations, as the relay has them.
  revocations: () => Promise<Signed<Revocation>[]>;
};

export function forgeHandler(o: ForgeConfig) {
  const { allow, forward } = forgeProxy(o);
  let devices: { at: number; list: Promise<Signed<Revocation>[]> } | undefined;
  const revoked = async (key: string): Promise<Revoked> => {
    if (!devices || devices.at + REVOKED_MS < Date.now()) {
      const list = o.revocations();
      devices = { at: Date.now(), list };
      list.catch(() => (devices = undefined));
    }
    const list = await devices.list;
    return { devices: list, grant: (hash, issuer) => o.records.revokedBy(hash).some((by) => by === issuer || by === key) };
  };

  // req: a channel's request under /forge/; from: the channel's peer.
  return async function forge(req: Request, from: Signed<DeviceCert>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.slice("/forge".length) || "/";
    const to = new URL(path + url.search, o.upstream);
    const user = o.records.user();
    if (!user) return error(503, "the account has no forge yet");
    if (from.body.role !== "relay") return forward(req, to, user, req.body);
    const a = o.account();
    if (!a) return error(503, "this node isn't signed in to its account");
    const raw = req.headers.get(CHAIN_HEADER);
    if (!raw) return error(401, `a relay-only device shows its grant (${CHAIN_HEADER})`);
    let chain: Chain;
    try {
      chain = JSON.parse(fromUtf8(fromB64url(raw)));
    } catch {
      return error(400, `${CHAIN_HEADER} isn't a chain`);
    }
    const checked = checkChain(a.id, a.key, chain, await revoked(a.key));
    if (typeof checked === "string") return error(403, checked);
    if (checked.holder !== from.body.device) return error(403, "the grant isn't held by this channel's device");
    const v = await allow(req, to, user, checked.scope!);
    if (!v.ok) return error(v.status, v.error);
    return forward(req, to, user, v.body, v.dropEncoding);
  };
}
