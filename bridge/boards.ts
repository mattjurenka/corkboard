// The bridge's half of cloud boards: Neovim asks it for cards, and it asks
// the Worker (cloud-session.ts). Neovim's requests come in on its RPC
// channel as the notification rpcnotify(chan, "corkboard.cloud", id, op,
// ...args); the bridge answers each with nvim_exec_lua of
// corkboard.cards.cloud.answer { id, error?, result? }, instead of passing
// them to the page (see server.ts's pump, and cards/cloud.lua for why not
// rpcrequest). Each event a board's socket brings goes to every subscribed
// Neovim as nvim_exec_lua of corkboard.cards.cloud_event, so a change made
// anywhere (another machine, an agent, the API) shows at once.
//
// Boards are the bridge's node's (node/app.ts's boards), their events from
// the node's replica, and so is the day plan (plan.lua's plan_*), its events
// from the node's day object as the Worker's user socket's would be.

import { hostname } from "node:os";
import { Cloud, Session as CloudSession, type Listener, USER } from "./cloud-session";
import { CLOUD, token } from "./cloud";
import { host } from "./host";
import * as remote from "./remote";
import type { AppNode } from "./node/app";
import type { Peers } from "./peers";

// cards/cloud.lua's board operations.
const BOARD_OPS = new Set(["resolve", "boards", "subscribe", "make", "create", "update", "log", "archive", "delete", "touch", "token", "revoke"]);

// The environment this machine is, as its fleetd names it (fleet/fleetd/queue.ts).
export const ENVIRONMENT = process.env.CORKBOARD_FLEET_ENVIRONMENT ?? hostname();

// A clone's remotes, origin first, as URLs another machine can clone from: no
// local paths, and no credentials in them.
async function remotes(root: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", root, "config", "--get-regexp", "^remote\\..*\\.url$"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return [];
  const urls = out
    .split("\n")
    .map((line) => line.match(/^remote\.(.+)\.url (\S+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .sort((a, b) => Number(b[1] === "origin") - Number(a[1] === "origin"))
    .map((m) => m[2].replace(/^(https?:\/\/)[^\/@]*@/, "$1"))
    .filter((u) => /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)\S{1,500}$/.test(u));
  return [...new Set(urls)].slice(0, 8);
}

export { USER, type Listener } from "./cloud-session";

const cloud = new Cloud({
  cloud: CLOUD,
  token,
  socket: (url, t) => new WebSocket(url, { headers: { Authorization: `Bearer ${t}` } } as any),
  environment: ENVIRONMENT,
  remotes,
  machine: () => ({ ...host(), environment: ENVIRONMENT }),
  self: remote.self,
  peers: () => peers,
});

// The bridge's node (node/app.ts), when it runs: the brains are its.
let node: AppNode | undefined;
export const useNode = (n: AppNode) => (node = n);
// The account's hubs, watched through the node (peers.ts).
let peers: Peers | undefined;
export const usePeers = (p: Peers) => (peers = p);

// A Neovim session's view of the cloud: what it follows, so closing the
// session stops its sockets once nobody else uses them. sessions: the fleet
// view's (away.ts's list, for this Neovim's page).
export class Session extends CloudSession {
  // The node's boards this session follows, and the way to stop.
  private following = new Set<string>();
  private unfollow?: () => void;
  // The node's day events this session follows.
  private unfollowDay?: () => void;

  constructor(listener: Listener, sessions?: () => unknown[]) {
    super(cloud, listener, sessions);
  }

  override async call(op: string, args: any[]): Promise<unknown> {
    if (op.startsWith("nodes_")) return node ? node.nodes(op, args) : null;
    // A new device let into the account (:AgentPair).
    if (op === "pair_status") return (await import("./e2ee")).pairStatus();
    if (op === "pair_approve") return (await import("./e2ee")).pairApprove(args[0], args[1]);
    if (op === "pair_confirm") return (await import("./e2ee")).pairConfirm(args[0], !!args[1]);
    // The calendar's Google consent (Connect calendar): its address, to open.
    if (op === "calendar_connect") {
      const res = await fetch(`${CLOUD}/api/calendar/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(`the calendar: ${json.error ?? `HTTP ${res.status}`}`);
      return json.url;
    }
    // Git through the forge gate (Give git access).
    if (op === "forge_status") return (await import("./e2ee")).forgeStatus();
    if (op === "forge_grant") return (await import("./e2ee")).forgeGrant(args[0]);
    if (op === "forge_grants") return (await import("./e2ee")).forgeGrants();
    if (op === "forge_revoke") return (await import("./e2ee")).forgeRevoke(args[0]);
    // A session on a board: queued with node: true, its grant the node's;
    // and, once the fleet's sealed on the node, queued by the node.
    if (node && op === "fleet_session") {
      const asked = args[2] ? [...args.slice(0, 3), true, ...args.slice(4)] : args;
      return (await node.fleet(op, asked)) ?? super.call(op, asked);
    }
    // The fleet view's, with what the node keeps sealed put back.
    if (node && op === "fleet_get") {
      const got = await super.call(op, args);
      return (await node.fleet("fleet_open", [got])) ?? got;
    }
    if (node && (op === "note_get" || op === "note_put" || op === "goals")) return node.notes(op, args);
    if (node && op.startsWith("plan_")) {
      if (op === "plan_subscribe") {
        this.unfollowDay ??= node.onDay((event) => this.listener(USER, event));
        return null;
      }
      if (op === "plan_boards") return this.board(node, "boards", []);
      return node.plans(op, args);
    }
    if (node && BOARD_OPS.has(op)) {
      const answer = await this.board(node, op, args);
      if (answer !== undefined) return answer;
    }
    const here = node && op.startsWith("brains_") ? await node.brains(op, args) : undefined;
    return here !== undefined ? here : super.call(op, args);
  }

  // A board operation, answered by the node.
  private async board(n: AppNode, op: string, args: any[]): Promise<unknown> {
    if (op === "resolve") return ((await n.boards("resolve", args)) as string | null) ?? args[0];
    const [key] = args;
    if (op !== "boards" && (typeof key !== "string" || !key)) return undefined;
    if (op === "subscribe" || op === "make") {
      const [, name, here, make, commit] = args;
      const found = here ? await remotes(here) : [];
      const place = { root: here ?? null, environment: ENVIRONMENT, ...(commit && { commit }), ...(found.length && { remotes: found }) };
      const answer = await n.boards(op, [key, name, place, op === "make" || !!make]);
      if (op === "subscribe" && answer !== null) {
        this.following.add(key);
        this.unfollow ??= n.onBoard((k, event) => this.following.has(k) && this.listener(k, event));
      }
      return answer;
    }
    return n.boards(op, args);
  }

  override close() {
    super.close();
    this.unfollow?.();
    this.unfollowDay?.();
  }
}
