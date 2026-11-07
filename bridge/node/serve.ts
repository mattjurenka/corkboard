// corkboard-bridge serve: the node (see .agent/plans/e2ee.md, "The node").
// Headless: this machine signs in as its device of the encrypted account,
// keeps decrypted replicas of the boards and brains its index lists (or
// of those it's given), and serves /mcp (for claude.ai and Claude Code,
// with its own OAuth) and the phone's API, on plain HTTP on this machine,
// and, signed in, through the relay's tunnel at <relay>/n/<handle> and on
// the sealed channels the account's devices open to it (channel.ts; its
// socket also tells the account's other devices this one is up; the
// leader, `e2ee leader`, is the node the tunnel prefers: see
// .agent/plans/local-memory.md, step 8). --origin names it when TLS ends
// here instead, behind Tailscale Funnel or Caddy.
//
//   corkboard-bridge serve [--port 8787] [--host 127.0.0.1] [--origin https://NAME]
//                          [--board KEY]... [--brain NAME]... [--timezone ZONE]
//   corkboard-bridge serve token [--name NAME] [--days 365] [--scope owner|assistant] [--brain NAME]
//                          a bearer for the phone's API, printed once
//   corkboard-bridge serve grants | revoke GRANT
//   corkboard-bridge serve calendar-login [--client-id ID --client-secret SECRET]
//                          [--calendar ID] [--timezone ZONE] | --file PATH
//   corkboard-bridge e2ee approve-connector
//                          a one-time code to approve a connector with at /authorize
//
// <state>/node/ has config.json (boards, brains, origin, port, host,
// timezone: what the flags add to), oauth.json, calendar.json, blobs/
// (cards' files, sealed, media.ts), and
// memory.db (the brains' episodes, episodes.ts, which consolidator.ts
// turns into their log and memory with `claude -p`, whose vectors embed.ts
// then makes and shares). Boards
// and brains given narrow the index to them. The account's passphrase, if
// it has one, is CORKBOARD_E2EE_PASSPHRASE.
//
// An account made --local (no relay yet) is served the same, from the
// replicas on disk alone: what's written waits in their queues until
// e2ee publish.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, signedIn, token } from "../cloud";
import { STATE_DIR } from "../dirs";
import { Keystore } from "../keystore";
import { Relay } from "../../lib/e2ee/relay";
import { indexId, indexKey } from "../../lib/e2ee/sharing";
import { type LogTransport, Replica, offline } from "../../lib/e2ee/sync";
import { accountObject, dayObject, fleetObject, listObjects } from "./objects";
import { FleetRecords, FORGE_GATE } from "./fleet";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { LocalEmbedder } from "./embed";
import { Episodes } from "./episodes";
import { Consolidator } from "./consolidator";
import { Handoff } from "./handoff";
import { Media } from "./media";
import { startLeases } from "./leases";
import { OAuthStore, SCOPES, type Scope, type Shared } from "./oauth";
import { type AppCall, type AppEvents, node } from "./server";
import { Hub } from "../hub";
import type { Reach } from "../peers";
import type { Channel } from "../../lib/e2ee/channel";
import { lentCalendar, loadCalendar, login, saveCalendar, startCalendar } from "./calendar";

export const NODE_DIR = join(STATE_DIR, "node");
const oauthStore = (shared?: Shared) => new OAuthStore(join(NODE_DIR, "oauth.json"), shared);
const calendarPath = join(NODE_DIR, "calendar.json");

type Config = { boards?: string[]; brains?: string[]; origin?: string; port?: number; host?: string; timezone?: string };

const options = (args: string[], name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const option = (args: string[], name: string) => options(args, name).at(-1);

function config(): Config {
  try {
    return JSON.parse(readFileSync(join(NODE_DIR, "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

// The Worker's fleet queue, as this machine signs in to it (cloud.ts).
async function fleetQueue(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CLOUD}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`the fleet: ${json.error ?? `HTTP ${res.status}`}`);
  return json;
}

// The calendar the node writes: its own (calendar-login), or the Worker's, lent.
const lent = lentCalendar(() => (signedIn() ? token().then((t) => fetch(`${CLOUD}/api/calendar/token`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(30_000) })) : undefined));
const calendar = async () => loadCalendar(calendarPath) ?? (await lent());

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// What `e2ee approve-connector` prints, and serve as it starts.
export const approvalCode = () => oauthStore().newApproval();

// One node per machine: two over the same replicas, as one device, would
// make ops with the same clocks. The lock is the running one's pid.
const LOCK = join(NODE_DIR, "lock");
export class NodeRunning extends Error {
  constructor(readonly pid: number) {
    super(`a node is running already (pid ${pid})`);
  }
}
function lock() {
  mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      throw new NodeRunning(pid);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw e;
  }
  writeFileSync(LOCK, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (Number(readFileSync(LOCK, "utf8")) === process.pid) rmSync(LOCK);
    } catch {}
  };
}

export type NodeOptions = { port?: number; host?: string; origin?: string; boards?: string[]; brains?: string[]; timezone?: string };

// The node, serving: `serve`'s, and the bridge's own (app.ts). Throws
// when this machine has no account, it can't be unlocked, or a node runs.
export async function startNode(o: NodeOptions = {}) {
  const c = config();
  const store = new Keystore();
  const d = store.device();
  if (!d || !store.exists()) throw new Error("this machine isn't in an encrypted account: corkboard-bridge e2ee init, recover or pair");
  if (d.relay !== null && d.relay !== CLOUD) throw new Error(`this machine's account is on ${d.relay}, not ${CLOUD} (CORKBOARD_CLOUD)`);
  if (store.needsPassphrase() && !process.env.CORKBOARD_E2EE_PASSPHRASE) throw new Error("the account key is under a passphrase: set CORKBOARD_E2EE_PASSPHRASE");
  const root = await store.root(process.env.CORKBOARD_E2EE_PASSPHRASE);
  const unlock = lock();
  try {
    let relay: LogTransport = offline;
    let r: Relay | undefined;
    if (d.relay) {
      r = new Relay({ origin: CLOUD, device: d.device, cert: d.cert, token: store.token(), onToken: (t) => store.saveToken(t) });
      await r.token();
      relay = r;
    }

    const index = await Replica.open({ transport: relay, key: indexKey(root), object: indexId(root), device: d.device.id, store: store.replica(indexId(root)) });
    if (d.relay) await index.pull().catch((e) => console.error(`node: reading the index: ${(e as Error).message}`));
    const want = { boards: [...(c.boards ?? []), ...(o.boards ?? [])], brains: [...(c.brains ?? []), ...(o.brains ?? [])] };
    const objects = [...listObjects(root, want, index), accountObject(root, "oauth", index), dayObject(root, index), fleetObject(root, index)];
    const replicas = await Replicas.open({ objects, transport: relay, device: d.device.id, store: (o) => store.replica(o), index, discover: () => listObjects(root, want, index) });
    await replicas.start();
    const data = new Data(replicas, o.timezone ?? c.timezone ?? localZone());
    const search = new Search(data, new LocalEmbedder(data));
    for (const b of data.brains()) search.warmLater(b.name, 0);
    const episodes = new Episodes(join(NODE_DIR, "memory.db"));
    // The tunnel, where the relay has one (an older one answers 404).
    let tunnel: { url: string; connected: boolean; stop(): void } | undefined;
    // Rollups on the node the tunnel goes to (the leader if it's connected,
    // else the newest), or on this one offline, with no tunnel or none
    // connected; the account's nodes asked once a minute. Another node
    // leading, this one's episodes are handed to it.
    let led: { at: number; leads: boolean } | undefined;
    const leads = async () => {
      if (!r || !tunnel) return true;
      if (led && Date.now() - led.at < 60_000) return led.leads;
      const v = await r.nodes();
      const nodes = v.connected.filter((c) => c.tunnel !== false);
      const to = nodes.find((c) => c.device === v.leader) ?? nodes.sort((a, b) => b.since - a.since)[0];
      led = { at: Date.now(), leads: !to || to.device === d.device.id };
      return led.leads;
    };
    const handoff = r && new Handoff({ replicas, episodes, blobs: r });
    const consolidator = new Consolidator({ data, episodes, after: (brain) => search.share(brain), leads, handoff });
    consolidator.start();
    // Working cards whose agents went quiet, blocked by the same node.
    const stopLeases = startLeases(data, leads);
    // Accepted days onto the calendar, by the same node.
    const stopCalendar = startCalendar({ data, replicas, leads, config: calendar });
    const hostname = o.host ?? c.host ?? "127.0.0.1";
    const origin = o.origin ?? c.origin;
    // claude.ai's grants, the same on every node of the account.
    const oauth = oauthStore({
      cards: () => replicas.get("account", "oauth")!.cards(),
      change: (...changes) => void replicas.change("account", "oauth", ...changes).catch((e) => console.error(`node: sharing grants: ${(e as Error).message}`)),
    });
    const media = new Media({ data, blobs: r, dir: join(NODE_DIR, "blobs") });
    const addBoard = (key: string) => replicas.add(listObjects(root, { boards: [key], brains: [] })[0]);
    // This machine's sessions, which its bridges join (ciphertext-relay.md step 3).
    const hub = new Hub();
    const fleet = () => (signedIn() ? fleetQueue : undefined);
    // What the fleet keeps sealed from the Worker (fleet.ts).
    // This machine signs the fleet's git grants (forge-keys.md), as a device of the account's.
    const forge = () => (r?.account && d.cert.body.role !== "relay" ? { account: r.account, device: { id: d.device.id, sign: d.device.sign }, cert: d.cert, gate: FORGE_GATE } : undefined);
    const sealed = new FleetRecords(replicas, fleet, forge);
    const served = { data, search, episodes, media, oauth, addBoard, fleet, sealed, calendar, hub };
    // Every hub of the account's (this one, and each connected device's on a
    // channel to it), for this machine's bridges to watch (peers.ts).
    const channels = new Map<string, Promise<Channel>>();
    const channel = (to: string) => {
      let c = channels.get(to);
      if (!c) {
        const p = (c = r!.channel(to));
        channels.set(to, p);
        const drop = () => channels.get(to) === p && channels.delete(to);
        p.then((ch) => ch.closed.then(drop), drop);
      }
      return c;
    };
    const reach: Reach = {
      devices: async () => ({ me: d.device.id, devices: [...new Set([d.device.id, ...(r && tunnel ? (await r.nodes()).connected.map((c) => c.device) : [])])] }),
      fetch: async (device, path, init = {}) => {
        if (device === d.device.id) return (await hub.serve(new Request(`http://node.invalid${path}`, { ...init, ...(init.body != null && { duplex: "half" }) } as RequestInit))) ?? Response.json({ error: "not found" }, { status: 404 });
        if (!r || !tunnel) return Response.json({ error: "this node has no relay" }, { status: 404 });
        let ch = await channel(device);
        if (!ch.open) {
          await ch.closed;
          ch = await channel(device);
        }
        return ch.fetch(path, init);
      },
    };
    let app: AppCall | undefined;
    let appEvents: AppEvents | undefined;
    const server = Bun.serve({ port: o.port ?? c.port ?? 8787, hostname, idleTimeout: 255, fetch: node({ ...served, origin, app: () => app, appEvents: () => appEvents, reach }) });
    if (r) {
      const nodes = await r.nodes().catch((e) => void console.error(`node: no tunnel: ${(e as Error).message}`));
      if (nodes) {
        const t = { url: nodes.url, connected: false, stop: () => {} };
        // The same HTTP on the sealed channels the account's devices open
        // (ciphertext-relay.md step 2), at the tunnel's origin, so the
        // phone's tokens work on either; never loopback. One with no
        // token is its device's, the owner (fleetd's relay-only one).
        const tunneled = node({ ...served, origin: nodes.url });
        t.stop = r.serveTunnel(tunneled, { name: d.cert.body.name, onState: (up) => (t.connected = up), channels: (req, ch) => tunneled(req, undefined, ch.peer) });
        tunnel = t;
      }
    }
    return {
      data,
      search,
      episodes,
      replicas,
      oauth,
      media,
      account: d.cert.body.account,
      device: d.device.id,
      online: !!d.relay,
      url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${server.port}`,
      origin,
      // The tunnel's public URL, and whether its socket is up.
      tunnel,
      relay: r,
      // A brain of this account's that the node doesn't keep yet, kept from now on.
      addBrain: (name: string) => replicas.add(listObjects(root, { boards: [], brains: [name] })[0]),
      // A board, the same way (a project's, made on this machine).
      addBoard,
      // The calendar the node writes accepted days to, if it has one.
      calendar,
      // The Worker's fleet queue while signed in, and what the fleet keeps sealed here.
      fleet,
      sealed,
      // This machine's sessions, for an in-process bridge to join.
      hub,
      reach,
      // The app's operations on the loopback /app (app.ts's), and its
      // boards' events on /app/events, not the tunnel's.
      serveApp: (f: AppCall, events: AppEvents) => void ((app = f), (appEvents = events)),
      async stop() {
        tunnel?.stop();
        server.stop();
        stopLeases();
        stopCalendar();
        await consolidator.stop();
        await replicas.stop();
        episodes.close();
        unlock();
      },
    };
  } catch (e) {
    unlock();
    throw e;
  }
}

export type StartedNode = Awaited<ReturnType<typeof startNode>>;

async function run(args: string[]) {
  const n = await startNode({
    port: option(args, "--port") ? Number(option(args, "--port")) : undefined,
    host: option(args, "--host"),
    origin: option(args, "--origin"),
    boards: options(args, "--board"),
    brains: options(args, "--brain"),
    timezone: option(args, "--timezone"),
  });
  if (!n.replicas.objects().some((o) => o.kind !== "account" && o.kind !== "day")) console.error("node: the index lists no boards or brains, and none were given (--board KEY, --brain NAME, or config.json); serving nothing");
  for (const s of n.replicas.status()) console.log(`${s.kind.padEnd(5)} ${s.name.padEnd(30)} ${String(s.records).padStart(5)} records  ${!n.online ? `${s.pending} kept here` : (s.error ?? "synced")}`);
  console.log(`\nnode on ${n.url}${n.origin ? `, as ${n.origin}` : ""}${n.tunnel ? `, and at ${n.tunnel.url}` : ""}, account ${n.account}${n.online ? "" : " (on this machine only)"}`);
  console.log(`approval code (10 minutes, once): ${approvalCode()}`);

  const quit = async () => {
    await n.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await new Promise(() => {});
}

function mintToken(args: string[]) {
  const scope = (option(args, "--scope") ?? "owner") as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`--scope is one of ${SCOPES.join(", ")}`);
  const days = Number(option(args, "--days") ?? 365);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days is a number of days");
  // --brain NAME: a token for that brain's agent (Pepper's, say), whose
  // memory is the brain's, its goals included.
  console.log(oauthStore().mint(option(args, "--name") ?? "phone", days, scope, option(args, "--brain")));
}

function grants() {
  for (const g of oauthStore().grants()) console.log(`${g.id}  ${g.scope.padEnd(9)} ${new Date(g.created).toISOString().slice(0, 10)}  ${g.tokens} tokens  ${g.name}`);
}

async function calendarLogin(args: string[]) {
  const file = option(args, "--file");
  if (file) {
    const f = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    const refresh = f.refresh ?? f.refresh_token;
    if (!f.client_id || !f.client_secret || !refresh || !f.calendar) throw new Error("the file needs client_id, client_secret, refresh_token and calendar");
    saveCalendar(calendarPath, { client_id: f.client_id, client_secret: f.client_secret, refresh, calendar: f.calendar, timezone: f.timezone ?? option(args, "--timezone") ?? localZone() });
    return console.log(`The calendar ${f.calendar} is the node's to write.`);
  }
  const client_id = option(args, "--client-id") ?? process.env.GOOGLE_CLIENT_ID;
  const client_secret = option(args, "--client-secret") ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error("calendar-login needs a Google OAuth desktop client: --client-id and --client-secret (or GOOGLE_CLIENT_ID/SECRET)");
  const calendar = await login({ client_id, client_secret, calendar: option(args, "--calendar"), timezone: option(args, "--timezone") ?? config().timezone ?? localZone(), path: calendarPath });
  console.log(`The calendar ${calendar} is the node's to write.`);
}

export async function cli(args: string[]) {
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "";
  const commands: Record<string, (a: string[]) => Promise<void> | void> = {
    "": run,
    token: mintToken,
    grants,
    revoke: (a) => console.log(oauthStore().revoke(a[1] ?? "") ? "Revoked." : "No such grant (serve grants lists them)."),
    "calendar-login": calendarLogin,
  };
  const go = commands[sub];
  if (!go) {
    console.error("usage: corkboard-bridge serve [--port N] [--host H] [--origin URL] [--board KEY]... [--brain NAME]... | token | grants | revoke GRANT | calendar-login");
    process.exit(2);
  }
  try {
    await go(args);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await cli(process.argv.slice(2));
