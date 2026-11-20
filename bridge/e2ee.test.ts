// The e2ee CLI (e2ee.ts), run as a user runs it, in its own process with
// its own state directory, against a relay (lib/testing/relay.ts) and a
// forge gate (forge/gate) served here: init --local, publish, revoke,
// rotated and rotate.

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKeys } from "../lib/e2ee/keys";
import { type Device, certify, newDevice } from "../lib/e2ee/device";
import { answerForge, bindForge } from "../lib/e2ee/forge";
import { fromPhrase } from "../lib/e2ee/phrase";
import { Relay } from "../lib/e2ee/relay";
import { rotate } from "../lib/e2ee/sharing";
import { Replica, memoryStore } from "../lib/e2ee/sync";
import { type DeviceCert, type Signed, b64url } from "../lib/e2ee/wire";
import { serveRelay } from "../lib/testing/relay";
import { createGate } from "../forge/gate/gate";
import { Store } from "../forge/gate/store";

const relay = await serveRelay();
afterAll(() => relay.stop());

// Forgejo as much as binding asks of it, and the gate before it.
const HEADER = "X-Forge-User";
const forgejo = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => (new URL(req.url).pathname === "/api/v1/user" && req.headers.get("authorization") === "token good" ? Response.json({ login: "matt" }) : Response.json({ ok: true })),
});
let gate: ReturnType<typeof createGate>;
const gateServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => gate.fetch(req) });
const GATE = `http://127.0.0.1:${gateServer.port}`;
gate = createGate({ origin: GATE, upstream: forgejo.url.href, userHeader: HEADER, corsOrigins: [], store: new Store(":memory:") });
afterAll(() => {
  gateServer.stop(true);
  forgejo.stop(true);
});

const state = mkdtempSync(join(tmpdir(), "corkboard-e2ee-cli-"));
afterAll(() => rmSync(state, { recursive: true, force: true }));
const E2EE = join(import.meta.dir, "e2ee.ts");
const { CORKBOARD_E2EE_PASSPHRASE: _, ...env } = process.env;

// The CLI, answering its questions with input.
async function cli(args: string[], input = "", gateOrigin = GATE) {
  const p = Bun.spawn([process.execPath, E2EE, ...args], {
    env: { ...env, CORKBOARD_STATE_DIR: state, CORKBOARD_DATA_DIR: join(state, "data"), CORKBOARD_CACHE_DIR: join(state, "cache"), CORKBOARD_CLOUD: relay.origin, CORKBOARD_FORGE_GATE: gateOrigin },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

// The root, from the phrase the CLI printed.
const phraseIn = (out: string) => fromPhrase([...out.matchAll(/\d+\. (\S+)/g)].map((m) => m[1]).join(" "));

// What the machine keeps, read as the CLI reads it: the root by its phrase,
// and its device (not by importing the keystore, whose directory, once
// imported, would be this one's for every test file in the process).
const kept = async () => phraseIn((await cli(["phrase"])).out);
const deviceFile = () => JSON.parse(readFileSync(join(state, "e2ee", "device.json"), "utf8")) as { cert: Signed<DeviceCert> };

// Another device of the account, as the test holds it.
async function device(root: Uint8Array, name: string) {
  const d = newDevice();
  const cert = certify(accountKeys(root), d, name);
  const r = new Relay({ origin: relay.origin, device: d, cert });
  return { d, cert, relay: r };
}

async function gateSession(account: string, holder: Device, cert: Signed<DeviceCert>) {
  const { nonce } = (await (await fetch(`${GATE}/gate/challenge`)).json()) as { nonce: string };
  const res = await fetch(`${GATE}/gate/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, chain: { cert }, answer: answerForge(holder, GATE, nonce) }) });
  return { status: res.status, token: ((await res.json()) as { token?: string }).token };
}

describe("the e2ee CLI", () => {
  let root: Uint8Array;
  let id: string;

  it("init --local makes the account on this machine only, once", async () => {
    const made = await cli(["init", "--local", "--name", "laptop"]);
    expect(made.code).toBe(0);
    expect(made.out).toContain("on this machine (laptop) only");
    root = phraseIn(made.out);
    id = accountKeys(root).id;
    expect(made.out).toContain(`Made the account ${id}`);
    expect(await kept()).toEqual(root);
    expect((await cli(["status"])).out).toContain("relay    none: only on this machine");
    expect(await cli(["shared"])).toMatchObject({ code: 1, err: expect.stringContaining("only on this machine; corkboard-bridge e2ee publish") });
    expect(await cli(["init", "--local"])).toMatchObject({ code: 1, err: expect.stringContaining("already in an account") });
    // The relay has never heard of it.
    await expect((await device(root, "phone")).relay.signIn()).rejects.toThrow();
  });

  it("publish puts it on the relay, with the invite it asks for", async () => {
    expect(await cli(["publish"])).toMatchObject({ code: 1, err: expect.stringContaining("/e2ee/accounts") });
    expect((await cli(["status"])).out).toContain("relay    none");
    const pub = await cli(["publish", "--invite", relay.invite]);
    expect(pub.code).toBe(0);
    expect(pub.out).toContain(`The account ${id} is on ${relay.origin} now`);
    expect((await cli(["status"])).out).toMatch(new RegExp(`relay    ${relay.origin}\n[^]*state    signed in`));
    expect((await (await device(root, "phone")).relay.signIn()).account).toBe(id);
    expect(await cli(["publish", "--invite", relay.invite])).toMatchObject({ code: 1, err: expect.stringContaining("is on " + relay.origin + " already") });
  });

  it("revoke ends a device at the relay and at the gate, and asks before this machine", async () => {
    const res = await fetch(`${GATE}/gate/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: await (await device(root, "x")).relay.accountView(id), bind: bindForge(accountKeys(root), id, GATE, "matt"), forgejo_token: "good" }) });
    expect(res.status).toBe(201);
    const phone = await device(root, "phone");
    await phone.relay.signIn();
    const s = await gateSession(id, phone.d, phone.cert);
    expect(s.status).toBe(201);

    expect(await cli(["revoke"])).toMatchObject({ code: 1, err: expect.stringContaining("revoke takes a device's id") });
    const r = await cli(["revoke", phone.d.id]);
    expect(r).toMatchObject({ code: 0, out: `Revoked ${phone.d.id}.\n` });
    await expect(new Relay({ origin: relay.origin, device: phone.d, cert: phone.cert }).signIn()).rejects.toThrow();
    expect((await fetch(`${GATE}/api/v1/version`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(401);
    expect((await gateSession(id, phone.d, phone.cert)).status).toBe(403);

    // A gate that can't be reached is said, and the relay's revocation stands.
    const tablet = await device(root, "tablet");
    await tablet.relay.signIn();
    const down = await cli(["revoke", tablet.d.id], "", "http://127.0.0.1:1");
    expect(down).toMatchObject({ code: 0, err: expect.stringContaining("The forge gate didn't take it") });
    await expect(new Relay({ origin: relay.origin, device: tablet.d, cert: tablet.cert }).signIn()).rejects.toThrow();

    const me = deviceFile().cert.body.device;
    expect((await cli(["revoke", me], "n\n")).code).toBe(0);
    expect((await cli(["status"])).out).toContain("state    signed in");
  });

  it("rotated takes this machine onto the root another device rotated to", async () => {
    const phone = await device(root, "phone");
    await phone.relay.signIn();
    const laptop = deviceFile().cert.body;
    const r = await rotate(phone.relay, root, id, phone.d, [laptop, phone.cert.body], {
      replica: (_root, object, key, epoch) => Replica.open({ transport: phone.relay, key, epoch, object, device: phone.d.id, store: memoryStore() }),
      keepRoot: async () => {},
    });
    const next = accountKeys(r.root).id;
    const got = await cli(["rotated"]);
    expect(got).toMatchObject({ code: 0, out: `This machine (laptop) is on ${id}'s new key, ${next}.\n` });
    expect(await kept()).toEqual(r.root);
    expect(deviceFile().cert.body.account).toBe(next);
    const status = (await cli(["status"])).out;
    expect(status).toContain(`account  ${id}`);
    expect(status).toContain(`signs as ${next} (rotated)`);
    expect(status).toContain("state    signed in");
    root = r.root;
  });

  it("rotate moves the account onto a new root, this machine its only device, when told to", async () => {
    const phone = await device(root, "phone");
    await phone.relay.signIn();
    expect(await cli(["rotate"], "n\n")).toMatchObject({ code: 0 });
    expect(await kept()).toEqual(root);

    const r = await cli(["rotate"], "y\n");
    expect(r.code).toBe(0);
    const fresh = phraseIn(r.out.slice(r.out.indexOf("The new recovery phrase")));
    const next = accountKeys(fresh).id;
    expect(r.out).toContain(`Rotated ${id} onto ${next}.`);
    expect(await kept()).toEqual(fresh);
    expect(deviceFile().cert.body.account).toBe(next);
    expect(existsSync(join(state, "e2ee", "rotating.json"))).toBe(false);
    // The device it didn't keep is out; this one's in on the new key.
    await expect(new Relay({ origin: relay.origin, device: phone.d, cert: phone.cert }).signIn()).rejects.toThrow();
    expect((await cli(["status"])).out).toContain("state    signed in");
    expect(b64url(fresh)).not.toBe(b64url(root));
  });
});
