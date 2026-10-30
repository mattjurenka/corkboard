// The bridge's half of cloud boards: Neovim asks it for cards, and it asks
// the Worker (cloud-session.ts). Neovim's requests come in on its RPC
// channel as the notification rpcnotify(chan, "corkboard.cloud", id, op,
// ...args); the bridge answers each with nvim_exec_lua of
// corkboard.cards.cloud.answer { id, error?, result? }, instead of passing
// them to the page (see server.ts's pump, and cards/cloud.lua for why not
// rpcrequest). Each event a board's socket brings goes to every subscribed
// Neovim as nvim_exec_lua of corkboard.cards.cloud_event, so a change made
// anywhere (another machine, an agent, the API) shows at once.

import { hostname } from "node:os";
import { Cloud, Session as CloudSession, type Listener } from "./cloud-session";
import { CLOUD, token } from "./cloud";
import { host } from "./host";
import { acceptedHere } from "./phone";
import * as remote from "./remote";

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
  acceptedHere,
});

// A Neovim session's view of the cloud: what it follows, so closing the
// session stops its sockets once nobody else uses them. sessions: the fleet
// view's (away.ts's list, for this Neovim's page).
export class Session extends CloudSession {
  constructor(listener: Listener, sessions?: () => unknown[]) {
    super(cloud, listener, sessions);
  }
}
