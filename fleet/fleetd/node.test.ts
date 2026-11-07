// fleetd's way to the node: its relay-only device, and the channel it
// opens to the leader or the newest node.   bun test fleet/fleetd

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, type Identity, initiate, pipe, respond } from "../../lib/e2ee/channel";
import { certify, checkCert, newDevice } from "../../lib/e2ee/device";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { b64url } from "../../lib/e2ee/wire";
import { type Opener, answerChannels, makeDevice, nodeFetch, readDevice, setOpener, storeCert } from "./node";

const keys = accountKeys(newRoot());
const dir = mkdtempSync(join(tmpdir(), "fleet-node-"));

function node(name: string): Identity {
  const d = newDevice();
  return { device: d, cert: certify(keys, d, name), trust: (c) => checkCert(keys.id, c, []) };
}

test("makes its keys once, and keeps only a relay-only cert of its own", () => {
  const file = join(dir, "keys.json");
  const d = makeDevice(file);
  expect(makeDevice(file).id).toBe(d.id);
  expect(() => storeCert(file, certify(keys, d, "fleetd"))).toThrow("relay-only");
  expect(() => storeCert(file, certify(keys, newDevice(), "fleetd", Date.now(), "relay"))).toThrow("another device's");
  storeCert(file, certify(keys, d, "fleetd", Date.now(), "relay"));
  expect(readDevice(file).cert?.body).toMatchObject({ device: d.id, box: b64url(d.box.public), role: "relay" });
});

test("asks the leader over a channel, or the newest node, and opens another once one ends", async () => {
  const file = join(dir, "fleet.json");
  const d = makeDevice(file);
  const me: Identity = { device: d, cert: certify(keys, d, "fleetd", Date.now(), "relay"), trust: (c) => checkCert(keys.id, c, []) };
  const [old, leader, newest] = [node("old"), node("leader"), node("newest")];
  let view = { leader: leader.device.id, connected: [old, leader, newest].map((n, i) => ({ device: n.device.id, since: i })) };
  const opened: string[] = [];
  const chans: Channel[] = [];
  let told: ((to: string | null) => void) | undefined;
  const fake: Opener = {
    serveTunnel: (_h, o) => ((told = o?.onLeader), () => {}),
    nodes: async () => ({ ...view, handle: "h", url: "https://relay/n/h" }),
    async channel(to) {
      opened.push(to);
      const n = [old, leader, newest].find((x) => x.device.id === to)!;
      let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
      a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
      b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
      const serve = async (req: Request, ch: Channel) =>
        Response.json({ at: n.cert.body.name, from: ch.peer.body.name, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : null });
      const [ch] = await Promise.all([initiate(a.link, me, to), respond(b.link, n, { serve })]);
      chans.push(ch);
      return ch;
    },
  };
  setOpener(file, fake);
  const link = { url: "https://relay/n/h", device: file };

  const got = await (await nodeFetch(link, "/api/node/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "brain" }) })).json();
  // No token: on a channel, the device is who it is.
  expect(got).toEqual({ at: "leader", from: "fleetd", path: "/api/node/grants", auth: null, body: { scope: "brain" } });
  await nodeFetch(link, "/api/node/boards");
  expect(opened).toEqual([leader.device.id]);

  // The leader moved, the old one still up: the relay says, and the next
  // request goes to the new one.
  answerChannels(link, async () => new Response(null));
  view = { leader: old.device.id, connected: view.connected };
  told!(old.device.id);
  await Bun.sleep(0);
  expect(((await (await nodeFetch(link, "/api/node/boards")).json()) as { at: string }).at).toBe("old");
  expect(opened).toEqual([leader.device.id, old.device.id]);
  // Told it's the one it has: kept.
  told!(old.device.id);
  await Bun.sleep(0);
  await nodeFetch(link, "/api/node/boards");
  expect(opened).toEqual([leader.device.id, old.device.id]);

  // The leader gone: the next is to the newest of those left.
  view = { leader: leader.device.id, connected: [old, newest].map((n, i) => ({ device: n.device.id, since: i })) };
  chans[1].close("the node went");
  expect(((await (await nodeFetch(link, "/api/node/boards")).json()) as { at: string }).at).toBe("newest");
  expect(opened).toEqual([leader.device.id, old.device.id, newest.device.id]);

  view = { leader: null as unknown as string, connected: [] };
  chans[2].close("the node went");
  await chans[2].closed;
  await expect(nodeFetch(link, "/api/node/boards")).rejects.toThrow("none of the account's nodes is connected");
});

test("without a device, the tunnel and the token file", async () => {
  const server = Bun.serve({ port: 0, fetch: (req) => Response.json({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname }) });
  writeFileSync(join(dir, "token"), "cbn_owner\n");
  const res = await nodeFetch({ url: `http://localhost:${server.port}`, tokenFile: join(dir, "token") }, "/api/node/day/events");
  expect(await res.json()).toEqual({ auth: "Bearer cbn_owner", path: "/api/node/day/events" });
  server.stop(true);
});
