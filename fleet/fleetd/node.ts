// fleetd's way to the user's node (Manifest.node). With a device (the
// relay-only one `corkboard-fleet device` makes, its cert from `corkboard-
// bridge e2ee relay-device`), a sealed channel through the relay to the
// leader, or else the newest node connected (lib/e2ee/channel.ts): the
// relay carries ciphertext only, and the device is the node's owner there,
// so no token. Without one, the tunnel's url with an owner token, as before
// (.agent/plans/ciphertext-relay.md, step 2).
//
// A channel is opened when first wanted and again after it ends.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLOUD } from "../../bridge/cloud";
import { type Channel, type Handler } from "../../lib/e2ee/channel";
import { type Device, checkCert, fromSecrets, newDevice } from "../../lib/e2ee/device";
import { Relay } from "../../lib/e2ee/relay";
import { type DeviceCert, type Signed, b64url, fromB64url } from "../../lib/e2ee/wire";

// device: the file `corkboard-fleet device` wrote.
export type NodeLink = { url: string; tokenFile?: string; device?: string };

type DeviceFile = { v: 1; sign: string; box: string; cert?: Signed<DeviceCert> };

export function readDevice(file: string): { device: Device; cert?: Signed<DeviceCert> } {
  const f = JSON.parse(readFileSync(file, "utf8")) as DeviceFile;
  return { device: fromSecrets(fromB64url(f.sign), fromB64url(f.box)), cert: f.cert };
}

// New keys at file, unless it has some.
export function makeDevice(file: string): Device {
  if (existsSync(file)) return readDevice(file).device;
  const d = newDevice();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, sign: b64url(d.sign.secret), box: b64url(d.box.secret) } satisfies DeviceFile, null, 2) + "\n", { mode: 0o600 });
  return d;
}

export function storeCert(file: string, cert: unknown) {
  const f = JSON.parse(readFileSync(file, "utf8")) as DeviceFile;
  const { device } = readDevice(file);
  const c = cert as Signed<DeviceCert>;
  const bad = checkCert(c?.body?.account, c);
  if (bad) throw new Error(`that cert: ${bad}`);
  if (c.body.device !== device.id || c.body.box !== b64url(device.box.public)) throw new Error("that cert is another device's");
  if (c.body.role !== "relay") throw new Error("that cert isn't a relay-only device's");
  writeFileSync(file, JSON.stringify({ ...f, cert: c }, null, 2) + "\n", { mode: 0o600 });
}

// What a channel's opened with, and answered on: the relay's, or a test's.
export type Opener = Pick<Relay, "nodes" | "channel"> & Partial<Pick<Relay, "serveTunnel">>;

const channels = new Map<string, Promise<Channel>>();
const openers = new Map<string, Opener>();

function opener(file: string): Opener {
  let o = openers.get(file);
  if (!o) {
    const { device, cert } = readDevice(file);
    if (!cert) throw new Error(`${file} has no cert yet: corkboard-fleet device cert < cert.json`);
    openers.set(file, (o = new Relay({ origin: CLOUD, device, cert })));
  }
  return o;
}

// For tests: what opens the channels for file.
export function setOpener(file: string, o: Opener) {
  openers.set(file, o);
  channels.delete(file);
}

async function open(file: string): Promise<Channel> {
  const r = opener(file);
  const v = await r.nodes();
  // Not a device that only answers channels: those aren't nodes.
  const { leader } = v;
  const connected = v.connected.filter((c) => c.tunnel !== false);
  const to = connected.some((c) => c.device === leader) ? leader! : connected.toSorted((a, b) => b.since - a.since)[0]?.device;
  if (!to) throw new Error("the node: none of the account's nodes is connected");
  return r.channel(to);
}

// The channel for file, opened if there's none; dropped when it ends or
// doesn't open, for the next call to open again.
function channel(file: string): Promise<Channel> {
  let c = channels.get(file);
  if (!c) {
    const p = (c = open(file));
    channels.set(file, p);
    const drop = () => channels.get(file) === p && channels.delete(file);
    p.then((ch) => ch.closed.then(drop), drop);
  }
  return c;
}

// The channels the account's devices open to fleetd's device (its
// sessions, ciphertext-relay.md step 3), on a socket of its own that the
// relay never sends the tunnel to; gives back the way to stop.
export function answerChannels(node: NodeLink, channels: Handler): () => void {
  if (!node.device) return () => {};
  return opener(node.device).serveTunnel?.(async () => new Response(null, { status: 404 }), { name: "fleetd", tunnel: false, channels }) ?? (() => {});
}

// A request to the node's HTTP, at its own paths (/api/node/...).
export async function nodeFetch(node: NodeLink, path: string, init: RequestInit = {}): Promise<Response> {
  if (!node.device) {
    if (!node.tokenFile) throw new Error("the manifest's node has neither a device nor a token file");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${readFileSync(node.tokenFile, "utf8").trim()}`);
    return fetch(`${node.url}${path}`, { ...init, headers });
  }
  // One that ended before this was sent is dropped for a new one; one
  // that ends while it's out isn't sent again, in case it was done.
  let ch = await channel(node.device);
  if (!ch.open) {
    await ch.closed;
    ch = await channel(node.device);
  }
  return ch.fetch(path, init);
}
