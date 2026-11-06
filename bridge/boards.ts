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
// A board the bridge's node keeps and the Worker doesn't (made here signed
// out, or moved off the Worker) is the node's instead (node/app.ts's
// boards), its events from the node's replica. One the node has a copy of
// that the Worker still has too (e2ee push-board's) stays the Worker's, so
// the two don't part, until it's moved (.agent/plans/local-boards.md, step 7).

import { hostname } from "node:os";
import { Cloud, Session as CloudSession, type Listener } from "./cloud-session";
import { CLOUD, signedIn, token } from "./cloud";
import { host } from "./host";
import * as remote from "./remote";
import type { AppNode } from "./node/app";

// cards/cloud.lua's board operations.
const BOARD_OPS = new Set(["resolve", "boards", "subscribe", "make", "create", "update", "log", "archive", "delete", "touch", "token", "revoke"]);

type Listed = { key: string; name: string; commit?: string | null };

// The node's boards; none from a node older than its board_* (another
// bridge's, on /app), whose boards are all the Worker's.
const nodeBoards = (n: AppNode) => (n.boards("boards", []) as Promise<Listed[]>).catch(() => [] as Listed[]);

// The environment this machine is, as its fleetd names it (fleet/fleetd/queue.ts).
const ENVIRONMENT = process.env.CORKBOARD_FLEET_ENVIRONMENT ?? hostname();

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
});

// The bridge's node (node/app.ts), when it runs: the brains are its.
let node: AppNode | undefined;
export const useNode = (n: AppNode) => (node = n);

// A Neovim session's view of the cloud: what it follows, so closing the
// session stops its sockets once nobody else uses them. sessions: the fleet
// view's (away.ts's list, for this Neovim's page).
export class Session extends CloudSession {
  // Whether each board the node keeps is the node's to answer.
  private theNodes = new Map<string, Promise<boolean>>();
  // The node's boards this session follows, and the way to stop.
  private following = new Set<string>();
  private unfollow?: () => void;

  constructor(listener: Listener, sessions?: () => unknown[]) {
    super(cloud, listener, sessions);
  }

  override async call(op: string, args: any[]): Promise<unknown> {
    if (op.startsWith("nodes_")) return node ? node.nodes(op, args) : null;
    // A session on the node's board: queued with node: true, its grant the node's.
    if (node && op === "fleet_session" && args[2] && signedIn() && (await this.nodes(node, args[2]))) return super.call(op, [...args.slice(0, 3), true]);
    if (node && (op === "note_get" || op === "note_put" || op === "goals")) return node.notes(op, args);
    if (node && BOARD_OPS.has(op)) {
      const answer = await this.board(node, op, args);
      if (answer !== undefined) return answer;
    }
    const here = node && op.startsWith("brains_") ? await node.brains(op, args) : undefined;
    return here !== undefined ? here : super.call(op, args);
  }

  // Signed in, the node's when it has the board and the Worker doesn't
  // (404, or 410 once moved). Asked once per board it has.
  private nodes(n: AppNode, key: string): Promise<boolean> {
    const known = this.theNodes.get(key);
    if (known) return known;
    const p = (async () => {
      if (!(await nodeBoards(n)).some((b) => b.key === key)) return false;
      const { status } = await this.cloud.api("GET", `/${encodeURIComponent(key)}/cards`);
      return status === 404 || status === 410;
    })();
    // A board the node doesn't have yet may be the node's later: not kept.
    p.then((v) => v || this.theNodes.delete(key), () => this.theNodes.delete(key));
    this.theNodes.set(key, p);
    return p;
  }

  // A board operation answered by the node, or undefined for the Worker's.
  private async board(n: AppNode, op: string, args: any[]): Promise<unknown> {
    // Both lists, the Worker's row for a board in each.
    if (op === "boards") {
      const mine = await nodeBoards(n);
      if (!signedIn()) return mine;
      const theirs = (await super.call("boards", [])) as Listed[];
      return [...theirs, ...mine.filter((b) => !theirs.some((t) => t.key === b.key))].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    }
    if (op === "resolve") {
      const [pathKey, commit] = args;
      const mine = signedIn() ? ((await n.boards("resolve", args).catch(() => null)) as string | null) : ((await n.boards("resolve", args)) as string | null);
      if (!signedIn()) return mine ?? pathKey;
      const theirs = ((await this.cloud.ok("GET", `?commit=${encodeURIComponent(commit)}`)) as Listed[]).filter((b) => b.commit === commit).map((b) => b.key);
      const found = [...theirs, ...(mine ? [mine] : [])];
      return found.includes(pathKey) ? pathKey : (found[0] ?? pathKey);
    }
    const [key] = args;
    if (typeof key !== "string" || !key) return undefined;
    // Signed out, every board is the node's, a new one too.
    if (signedIn() && !(await this.nodes(n, key))) return undefined;
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
  }
}
