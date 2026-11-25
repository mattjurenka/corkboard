// The first start's question (onboarding.ts), as the page asks it, each
// machine a process with its own state directory against a relay
// (lib/testing/relay.ts): made here, recovered from its phrase, joined from
// a device already in it.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKeys, newRoot } from "../lib/e2ee/keys";
import { certify, creation, newDevice } from "../lib/e2ee/device";
import { approve } from "../lib/e2ee/pairing";
import { toPhrase } from "../lib/e2ee/phrase";
import { Relay } from "../lib/e2ee/relay";
import { serveRelay } from "../lib/testing/relay";

const relay = await serveRelay();
const dirs: string[] = [];
const procs: { kill(): void }[] = [];
afterAll(() => {
  procs.forEach((p) => p.kill());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  relay.stop();
});
const { CORKBOARD_E2EE_PASSPHRASE: _, ...env } = process.env;

// onboarding.ts's routes on a port, and how often ready was called; it takes
// READY_MS to start the node, and fails its first READY_FAILS times; one
// that takes longer than NODE_MS counts as failed.
const PROGRAM = `
import { account, limits } from ${JSON.stringify(join(import.meta.dir, "onboarding.ts"))};
if (process.env.NODE_MS) limits.nodeMs = Number(process.env.NODE_MS);
let ready = 0;
const start = async () => {
  ready++;
  await Bun.sleep(Number(process.env.READY_MS ?? 0));
  if (ready <= Number(process.env.READY_FAILS ?? 0)) throw new Error("no node");
};
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  return p === "/ready" ? Response.json(ready) : account(req, p, start);
} });
console.log(s.port);
`;

async function machine(more: Record<string, string> = {}) {
  const state = mkdtempSync(join(tmpdir(), "corkboard-onboarding-"));
  dirs.push(state);
  const p = Bun.spawn([process.execPath, "-e", PROGRAM], {
    env: { ...env, CORKBOARD_STATE_DIR: state, CORKBOARD_DATA_DIR: join(state, "data"), CORKBOARD_CACHE_DIR: join(state, "cache"), CORKBOARD_CLOUD: relay.origin, ...more },
    stdout: "pipe",
    stderr: "inherit",
  });
  procs.push(p);
  const { value } = await p.stdout.getReader().read();
  const url = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(url + path, body === undefined && path === "/account" ? {} : { method: "POST", body: JSON.stringify(body ?? {}) });
    return { status: res.status, ...((await res.json()) as Record<string, any>) } as { status: number } & Record<string, any>;
  };
  const ready = async () => (await fetch(url + "/ready")).json();
  return { call, ready };
}

// An account on the relay, with a device of its own signed in.
async function published() {
  const root = newRoot();
  const keys = accountKeys(root);
  const device = newDevice();
  const cert = certify(keys, device, "phone");
  const r = new Relay({ origin: relay.origin, device, cert });
  await r.createAccount(creation(keys, relay.origin, relay.invite), cert);
  await r.signIn();
  return { root, id: keys.id, relay: r };
}

const until = async <T>(get: () => Promise<T | undefined>, ms = 15_000): Promise<T> => {
  for (const end = Date.now() + ms; ; await Bun.sleep(50)) {
    const got = await get();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error("timed out");
  }
};

describe("the first start", () => {
  it("makes an account here once, showing its phrase", async () => {
    const m = await machine();
    expect(await m.call("/account")).toMatchObject({ status: 200, account: false, join: null });
    const made = await m.call("/account/create");
    expect(made.status).toBe(200);
    expect(made.phrase.split(" ")).toHaveLength(24);
    expect(await m.ready()).toBe(1);
    expect(await m.call("/account")).toMatchObject({ account: true });
    expect(await m.call("/account/create")).toMatchObject({ status: 400, error: expect.stringContaining("already in an account") });
    expect(await m.call("/account/join")).toMatchObject({ status: 409 });
  });

  it("recovers one from its phrase, and not from a wrong one", async () => {
    const a = await published();
    const m = await machine();
    expect(await m.call("/account/recover", { phrase: "not a phrase" })).toMatchObject({ status: 400 });
    expect(await m.call("/account")).toMatchObject({ account: false });
    expect(await m.call("/account/recover", { phrase: toPhrase(a.root) })).toMatchObject({ status: 200, account: a.id });
    expect(await m.ready()).toBe(1);
  });

  it("joins one another device approves, the six digits checked on both", async () => {
    const a = await published();
    const m = await machine();
    const { join: shown } = await m.call("/account/join");
    expect(shown.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    let seen = "";
    const approved = approve(a.relay, a.root, shown.code, { confirm: async (sas) => ((seen = sas), true) });
    const sas = await until(async () => (await m.call("/account")).join?.sas as string | undefined);
    const answered = await m.call("/account/join/confirm", { ok: true });
    expect(answered.join.sas).toBeUndefined();
    expect(answered.join.code).toBe(shown.code);
    await approved;
    expect(sas).toBe(seen);
    expect(await until(async () => (await m.call("/account")).join?.account)).toBe(a.id);
    expect(await m.call("/account")).toMatchObject({ account: true });
    expect(await m.ready()).toBe(1);
  });

  it("stays out when the digits don't match, and can try again", async () => {
    const a = await published();
    const m = await machine();
    const first = (await m.call("/account/join")).join;
    const approved = approve(a.relay, a.root, first.code, { confirm: async () => true }).catch((e) => e);
    await until(async () => (await m.call("/account")).join?.sas);
    await m.call("/account/join/confirm", { ok: false });
    expect(await until(async () => (await m.call("/account")).join?.error)).toContain("didn't match");
    await approved;
    expect(await m.call("/account")).toMatchObject({ account: false });
    expect(await m.ready()).toBe(0);
    const again = (await m.call("/account/join")).join;
    expect(again.code).not.toBe(first.code);
    await m.call("/account/join/cancel");
    expect(await m.call("/account")).toMatchObject({ join: null });
  });

  it("says there's an account only once its node is up, and makes one at a time", async () => {
    const m = await machine({ READY_MS: "1000" });
    const made = m.call("/account/create");
    await until(async () => ((await m.ready()) === 1 ? true : undefined));
    expect(await m.call("/account")).toMatchObject({ account: false });
    expect(await m.call("/account/create")).toMatchObject({ status: 409 });
    expect(await m.call("/account/join")).toMatchObject({ status: 409 });
    expect((await made).phrase.split(" ")).toHaveLength(24);
    expect(await m.call("/account")).toMatchObject({ account: true });
  });

  it("shows the phrase when the node doesn't start", async () => {
    const m = await machine({ READY_FAILS: "1" });
    const made = await m.call("/account/create");
    expect(made.status).toBe(200);
    expect(made.phrase.split(" ")).toHaveLength(24);
    expect(await m.ready()).toBe(1);
    expect(await m.call("/account")).toMatchObject({ account: true });
    expect(await m.ready()).toBe(2);
    await m.call("/account");
    expect(await m.ready()).toBe(2);
  });

  it("starts a node that didn't start once again, however many ask", async () => {
    const m = await machine({ READY_FAILS: "1", READY_MS: "300" });
    await m.call("/account/create");
    const asked = await Promise.all([m.call("/account"), m.call("/account"), m.call("/account")]);
    expect(asked.map((a) => a.account)).toEqual([true, true, true]);
    expect(await m.ready()).toBe(2);
  });

  it("goes on with a join whose digits matched, whatever else is asked", async () => {
    const a = await published();
    const m = await machine({ READY_MS: "1500" });
    const { join: shown } = await m.call("/account/join");
    const approved = approve(a.relay, a.root, shown.code, { confirm: async () => true });
    await until(async () => (await m.call("/account")).join?.sas);
    await m.call("/account/join/confirm", { ok: true });
    await approved;
    expect(await m.call("/account/join/cancel")).toMatchObject({ status: 409 });
    expect(await m.call("/account/create")).toMatchObject({ status: 409 });
    expect(await m.call("/account/recover", { phrase: toPhrase(a.root) })).toMatchObject({ status: 409 });
    expect(await m.call("/account")).toMatchObject({ account: false, join: { accepted: true } });
    expect(await until(async () => (await m.call("/account")).join?.account)).toBe(a.id);
    expect(await m.call("/account")).toMatchObject({ account: true });
  });

  it("lets a join go when its node doesn't start in time", async () => {
    const a = await published();
    const m = await machine({ READY_MS: "60000", NODE_MS: "500" });
    const { join: shown } = await m.call("/account/join");
    const approved = approve(a.relay, a.root, shown.code, { confirm: async () => true });
    await until(async () => (await m.call("/account")).join?.sas);
    await m.call("/account/join/confirm", { ok: true });
    await approved;
    expect(await until(async () => (await m.call("/account")).join?.account)).toBe(a.id);
    expect(await m.call("/account/create")).toMatchObject({ status: 400, error: expect.stringContaining("already in an account") });
  });
});
