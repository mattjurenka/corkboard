import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKeys, newRoot } from "../../lib/e2ee/keys";
import { certify, checkCert, newDevice } from "../../lib/e2ee/device";
import { type MailboxView, pairNew } from "../../lib/e2ee/pairing";
import { Relay } from "../../lib/e2ee/relay";
import { offline } from "../../lib/e2ee/sync";
import { CODE_ALPHABET, normalizeCode } from "../../lib/e2ee/wire";
import { Keystore } from "../keystore";
import { pairApprove, pairConfirm } from "../e2ee";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import type { Caller } from "./oauth";
import { type Node, mcp } from "./mcp";

const ORIGIN = "https://node.test";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// The relay's pairing mailboxes (relay/src/mailbox.ts) and sign-in, in
// memory over HTTP: each step once and in order, the approver the first
// signed-in account to commit, the mailbox gone once the new device has
// seen the delivery.
type Box = { secret: string; expires: number; account?: string } & Omit<MailboxView, "code" | "expires">;
function relayServer() {
  const boxes = new Map<string, Box>();
  const tokens = new Map<string, string>();
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const b = (await req.json().catch(() => ({}))) as Record<string, any>;
      if (p === "/e2ee/challenge") return json({ nonce: "n", expires: Date.now() + 60_000 });
      if (p === "/e2ee/token") {
        if (checkCert(b.cert?.body?.account, b.cert)) return json({ error: "bad cert" }, 401);
        const token = `cbe_${crypto.randomUUID()}`;
        tokens.set(token, b.cert.body.account);
        return json({ token, expires: Date.now() + 3600_000, account: b.cert.body.account });
      }
      if (p === "/e2ee/pair") {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => CODE_ALPHABET[x & 31]).join("");
        const secret = crypto.randomUUID();
        boxes.set(code, { secret, expires: Date.now() + 600_000 });
        return json({ code, secret, expires: boxes.get(code)!.expires }, 201);
      }
      const [, raw, step] = p.match(/^\/e2ee\/pair\/([^/]+)(?:\/(\w+))?$/) ?? [];
      const code = normalizeCode(decodeURIComponent(raw ?? "")) ?? "";
      const box = boxes.get(code);
      if (!box) return json({ error: "no such pairing (or it has ended)" }, 404);
      const view = { code, expires: box.expires, commit: box.commit };
      if (typeof b.secret === "string") {
        if (b.secret !== box.secret) return json({ error: "not this pairing's device" }, 403);
        if (!step) {
          if (box.deliver) boxes.delete(code);
          return json({ ...view, join: box.join, reveal: box.reveal, deliver: box.deliver });
        }
        if (step === "cancel") return boxes.delete(code), json(true);
        if (step !== "join" || !box.commit || box.join) return json({ error: "out of order" }, 409);
        box.join = { box: b.box, device: b.device, name: b.name };
        return json(true);
      }
      const account = tokens.get(req.headers.get("Authorization")?.slice(7) ?? "");
      if (!account) return json({ error: "sign in first" }, 401);
      if (box.account && box.account !== account) return json({ error: "another account is approving this pairing" }, 403);
      if (!step) return json({ ...view, ...(box.account && { join: box.join, reveal: box.reveal }) });
      if (step === "cancel") return boxes.delete(code), json(true);
      if (step === "commit" && !box.commit) return Object.assign(box, { account, commit: b.commit }), json(true);
      if (step === "reveal" && box.join && !box.reveal) return (box.reveal = b.approver), json(true);
      if (step === "deliver" && box.reveal && !box.deliver) return (box.deliver = { nonce: b.nonce, ciphertext: b.ciphertext }), json(true);
      return json({ error: "out of order" }, 409);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, boxes, stop: () => server.stop(true) };
}

// This machine, in an account on that relay: its keystore, and the node's
// /mcp with pair_* going through it.
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-pairing-"));
  dirs.push(dir);
  const relay = relayServer();
  const root = newRoot();
  const keys = accountKeys(root);
  const me = newDevice();
  const store = new Keystore(join(dir, "e2ee"));
  await store.saveRoot(root);
  store.saveDevice(relay.url, "laptop", me, certify(keys, me, "laptop"));
  const replicas = await Replicas.open({ objects: listObjects(root, { boards: ["proj"], brains: ["assistant"] }), transport: offline, device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const at = { store, relay: relay.url };
  const n: Node = { data, search: new Search(data), origin: ORIGIN, pairing: { approve: (code) => pairApprove(code, undefined, at), confirm: pairConfirm } };
  const call = async (caller: Caller, method: string, params: unknown) => {
    const res = await mcp(new Request(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), n, caller);
    return (await res.json()) as { result?: any; error?: { message: string } };
  };
  const tool = async (caller: Caller, name: string, args: Record<string, unknown>) => {
    const r = await call(caller, "tools/call", { name, arguments: args });
    if (r.error) return { error: true, text: r.error.message };
    return { error: !!r.result.isError, text: r.result.content[0].text as string };
  };
  return { dir, relay, root, keys, store, at, call, tool, stop: async () => (relay.stop(), await replicas.stop()) };
}

const OWNER: Caller = { scope: "owner", agent: "phone", grant: "g1", resource: null };
const fast = { interval: 5 };

// A new device showing its code, as `e2ee pair` does: it says yes only if
// its six digits are the ones the user was shown.
function newPhone(relay: string) {
  const device = newDevice();
  let shown!: (code: string) => void;
  const code = new Promise<string>((r) => (shown = r));
  let told!: (digits: string) => void;
  const digits = new Promise<string>((r) => (told = r));
  const joined = pairNew(new Relay({ origin: relay }), device, "phone", { show: (c) => shown(c), confirm: async (sas) => sas === (await digits).replace(" ", "") }, fast);
  joined.catch(() => {});
  return { device, code, joined, tell: told };
}

describe("pairing a device from chat", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => void (n = await setup()));
  afterAll(() => n.stop());

  it("lets the device in once the user says the digits match, and only once", async () => {
    const phone = newPhone(n.relay.url);
    const code = await phone.code;
    // As the user typed it.
    const typed = `${code.slice(0, 5).toLowerCase()} - ${code.slice(5)}`;
    const asked = await n.tool(OWNER, "pair_device", { code: typed });
    expect(asked.error).toBe(false);
    const { id, device, digits } = JSON.parse(asked.text) as { id: string; device: string; digits: string };
    expect(device).toBe("phone");
    expect(digits).toMatch(/^\d{3} \d{3}$/);
    phone.tell(digits);
    const confirmed = await n.tool(OWNER, "pair_confirm", { id, match: true });
    expect(JSON.parse(confirmed.text)).toEqual({ paired: "phone" });
    const got = await phone.joined;
    expect(got.root).toEqual(n.root);
    expect(checkCert(n.keys.id, got.cert)).toBeNull();
    expect(got.cert.body.device).toBe(phone.device.id);
    // The mailbox is gone, and the answer can't be given twice.
    expect(n.relay.boxes.has(code)).toBe(false);
    expect(await n.tool(OWNER, "pair_confirm", { id, match: true })).toEqual({ error: true, text: "that pairing is over; start again" });
    // Nor the code used again.
    expect((await n.tool(OWNER, "pair_device", { code })).text).toMatch(/no device is showing that code/);
  });

  it("turns the device away when the user says they don't match", async () => {
    const phone = newPhone(n.relay.url);
    const code = await phone.code;
    const { id, digits } = JSON.parse((await n.tool(OWNER, "pair_device", { code })).text) as { id: string; digits: string };
    phone.tell(digits);
    const no = await n.tool(OWNER, "pair_confirm", { id, match: false });
    expect(no).toEqual({ error: true, text: "pairing: the codes didn't match" });
    await expect(phone.joined).rejects.toThrow();
    expect(n.relay.boxes.has(code)).toBe(false);
    // Anything but true is no.
    const again = newPhone(n.relay.url);
    const second = JSON.parse((await n.tool(OWNER, "pair_device", { code: await again.code })).text) as { id: string; digits: string };
    again.tell(second.digits);
    expect((await n.tool(OWNER, "pair_confirm", { id: second.id, match: "true" })).error).toBe(true);
    await expect(again.joined).rejects.toThrow();
  });

  it("refuses what isn't a code, one no device shows, and an id it never gave", async () => {
    expect(await n.tool(OWNER, "pair_device", { code: "hello" })).toEqual({ error: true, text: "that isn't a code: it's the ten letters and digits the new device shows" });
    expect(await n.tool(OWNER, "pair_device", {})).toMatchObject({ error: true, text: expect.stringMatching(/isn't a code/) });
    expect((await n.tool(OWNER, "pair_device", { code: "ABCDE-FGHJK" })).text).toMatch(/no device is showing that code/);
    expect(await n.tool(OWNER, "pair_confirm", { id: "constructor", match: true })).toEqual({ error: true, text: "that pairing is over; start again" });
  });

  it("is the user's own clients' only: not an assistant's, a brain's, or an agent's on a card", async () => {
    const names = async (c: Caller) => ((await n.call(c, "tools/list", {})).result.tools as { name: string }[]).map((t) => t.name);
    expect(await names(OWNER)).toEqual(expect.arrayContaining(["pair_device", "pair_confirm"]));
    const others: Caller[] = [
      { scope: "assistant", agent: "claude.ai", grant: "g2", resource: null },
      { scope: "owner", agent: "pepper", grant: "g3", resource: null, brain: "assistant" },
      { scope: "card", agent: "claude", grant: "g4", resource: null, board: "proj", card: "TASK-1" },
      { scope: "session", agent: "fleet", grant: "g5", resource: null, board: "proj", spawn: "s1" },
    ];
    const phone = newPhone(n.relay.url);
    const code = await phone.code;
    for (const c of others) {
      expect(await names(c)).not.toContain("pair_device");
      expect((await n.tool(c, "pair_device", { code })).error).toBe(true);
    }
    // None of them got as far as the relay.
    expect(n.relay.boxes.get(code)?.commit).toBeUndefined();
  });

  it("needs this machine to be in an account on the relay", async () => {
    const elsewhere = new Keystore(join(n.dir, "elsewhere"));
    const d = newDevice();
    await elsewhere.saveRoot(newRoot());
    elsewhere.saveDevice(null, "laptop", d, certify(accountKeys(newRoot()), d, "laptop"));
    await expect(pairApprove("ABCDE-FGHJK", undefined, { store: elsewhere, relay: n.relay.url })).rejects.toThrow(/isn't in an account/);
    await expect(pairApprove("ABCDE-FGHJK", undefined, { store: new Keystore(join(n.dir, "none")), relay: n.relay.url })).rejects.toThrow(/isn't in an account/);
  });
});
