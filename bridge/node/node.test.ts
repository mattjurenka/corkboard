import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot, random } from "../../lib/e2ee/keys";
import { entries, indexId, indexKey, remember } from "../../lib/e2ee/sharing";
import { EpochChanged, type LogTransport, type ReplicaStore, Replica, memoryStore, offline } from "../../lib/e2ee/sync";
import { type NewOp, type Snapshot, type TunnelRequest, type TunnelResponse, type WireOp, b64url, fromB64url, utf8 } from "../../lib/e2ee/wire";
import { Relay } from "../../lib/e2ee/relay";
import { listObjects, noteRecord } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { isCard, newCardId } from "./board";
import { Search } from "./search";
import { Episodes } from "./episodes";
import { Consolidator } from "./consolidator";
import { type Blobs, Handoff } from "./handoff";
import { Media, PIECE } from "./media";
import { type Embed, LocalEmbedder, dequantize, pieces, quantize } from "./embed";
import { QUIET } from "../../lib/memory/consolidate";
import { OAuthStore, type Shared, publicAddress, redirectAllowed, sameRedirect } from "./oauth";
import type { CardChange } from "../../lib/e2ee/merge";
import { node, originOf } from "./server";
import { moveMemory } from "./move";
import { boardEvents, boards, notes } from "./app";
import { LEASE_MS, sweep, touch } from "./leases";
import type { BoardEvent } from "../../lib/model/cards";

// A relay in memory: a log per object, ordered by pos, as the Worker keeps
// them, with its epoch and snapshot. state.pad is added to what a read
// says is kept, to make a log worth compacting; state.refuse fails snapshots.
type Log = { ops: WireOp[]; ids: Map<string, number>; head: number; epoch: number; snapshot?: Snapshot };
function relay(): LogTransport & { state: { pad: number; refuse: boolean; logs: Map<string, Log> } } {
  const state = { pad: 0, refuse: false, logs: new Map<string, Log>() };
  const logOf = (object: string) => state.logs.get(object) ?? (state.logs.set(object, { ops: [], ids: new Map(), head: 0, epoch: 0 }), state.logs.get(object)!);
  return {
    state,
    async append(object: string, ops: NewOp[]) {
      const log = logOf(object);
      return ops.map((o) => {
        const had = log.ids.get(o.id);
        if (had) return { id: o.id, pos: had };
        if ((o.epoch ?? 0) !== log.epoch) throw new EpochChanged(log.epoch);
        const w: WireOp = { ...o, device: DEVICE_OF.get(o.id) ?? "?", pos: ++log.head, ts: new Date().toISOString() };
        log.ops.push(w);
        log.ids.set(o.id, w.pos);
        return { id: o.id, pos: w.pos };
      });
    },
    async read(object: string, since: number) {
      const log = logOf(object);
      const snap = log.snapshot && since < log.snapshot.upTo ? log.snapshot : undefined;
      const ops = log.ops.filter((w) => w.pos > (snap?.upTo ?? since));
      return { ops, head: log.head, epoch: log.epoch, count: log.ops.length && log.ops.length + state.pad, bytes: 0, ...(snap && { snapshot: snap }) };
    },
    async snapshot(object: string, s: Snapshot) {
      const log = logOf(object);
      if (state.refuse) throw new Error("no snapshots today");
      if (s.upTo > log.head || s.upTo <= (log.snapshot?.upTo ?? 0) || (s.epoch > log.epoch && s.upTo !== log.head)) throw Object.assign(new Error("conflict"), { status: 409 });
      log.snapshot = s;
      log.epoch = s.epoch;
      log.ops = log.ops.filter((w) => w.pos > s.upTo);
    },
  };
}
// The relay labels an op with the device that signed in to push it; here,
// each pushing transport says which device it is.
const DEVICE_OF = new Map<string, string>();
const as = <T extends LogTransport>(t: T, device: string): T => ({
  ...t,
  append: (object, ops) => {
    for (const o of ops) DEVICE_OF.set(o.id, device);
    return t.append(object, ops);
  },
});

const ORIGIN = "https://node.test";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-node-"));
  dirs.push(dir);
  const root = newRoot();
  const shared = relay();
  const objects = listObjects(root, { boards: ["proj"], brains: ["assistant"] });
  const replicas = await Replicas.open({ objects, transport: as(shared, "node"), device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const search = new Search(data);
  const oauth = new OAuthStore(join(dir, "oauth.json"));
  const episodes = new Episodes();
  const blobs = memoryBlobs();
  const media = new Media({ data, blobs, dir: join(dir, "blobs") });
  const app = node({ data, search, oauth, episodes, media, origin: ORIGIN });
  // Another device of the account: the laptop, on the same relay.
  const board = objects.find((o) => o.kind === "board")!;
  const laptop = await Replica.open({ transport: as(shared, "laptop"), key: board.key, object: board.object, device: "laptop" });
  const call = (path: string, init: RequestInit = {}) => app(new Request(`${ORIGIN}${path}`, init));
  return { dir, root, replicas, data, search, oauth, episodes, media, blobs, app, call, laptop, stop: () => replicas.stop() };
}

// The relay's blobs, in memory.
function memoryBlobs(): Blobs & { kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>();
  return {
    kept,
    putBlob: async (id, b) => (kept.has(id) ? Promise.reject(Object.assign(new Error("that blob exists"), { status: 409 })) : void kept.set(id, b)),
    getBlob: async (id) => kept.get(id) ?? Promise.reject(Object.assign(new Error("no such blob"), { status: 404 })),
    deleteBlob: async (id) => void kept.delete(id),
  };
}

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const rpc = (method: string, params: unknown, token: string, id = 1) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});
const toolText = async (res: Response) => {
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { error: !!j.result.isError, text: j.result.content[0].text };
};

describe("the node's OAuth", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => void (n = await setup()));
  afterAll(() => n.stop());

  it("says where to sign in", async () => {
    const res = await n.call("/mcp", rpc("tools/list", {}, "nothing"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="assistant"`);
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = (await (await n.call(p)).json()) as Record<string, unknown>;
      expect(prm.resource).toBe(`${ORIGIN}/mcp`);
      expect((prm.authorization_servers as string[])[0]).toBe(ORIGIN);
    }
    const as = (await (await n.call("/.well-known/oauth-authorization-server")).json()) as Record<string, any>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.registration_endpoint).toBe(`${ORIGIN}/register`);
  });

  it("registers, authorizes with PKCE and an approval code, issues, refreshes and rotates, and lets /mcp in", async () => {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await n.call("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    expect(reg.status).toBe(201);
    const { client_id, client_secret } = (await reg.json()) as { client_id: string; client_secret?: string };
    expect(client_secret).toBeUndefined();

    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "assistant", resource: `${ORIGIN}/mcp` });
    const consent = await n.call(`/authorize?${q}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("claude.ai");
    const request = html.match(/name="request" value="([^"]+)"/)![1];

    const wrong = await n.call("/authorize", form({ request, code: "AAAA-AAAA", action: "approve" }));
    expect(await wrong.text()).toContain("wrong code");

    const code = n.oauth.newApproval();
    const ok = await n.call("/authorize", form({ request, code: code.toLowerCase(), action: "approve" }));
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    const authCode = back.searchParams.get("code")!;
    // The approval code is spent.
    expect(n.oauth.spendApproval(code)).toBe(false);

    const badVerifier = await n.call("/token", form({ grant_type: "authorization_code", code: authCode, client_id, redirect_uri: redirect, code_verifier: "x".repeat(43) }));
    expect(((await badVerifier.json()) as { error: string }).error).toBe("invalid_grant");
    // That spent the code: a code is good once, right or wrong.
    const again = await n.call("/token", form({ grant_type: "authorization_code", code: authCode, client_id, redirect_uri: redirect, code_verifier: verifier }));
    expect(again.status).toBe(400);

    // So round again, rightly this time.
    const consent2 = await (await n.call(`/authorize?${q}`)).text();
    const request2 = consent2.match(/name="request" value="([^"]+)"/)![1];
    const ok2 = await n.call("/authorize", form({ request: request2, code: n.oauth.newApproval(), action: "approve" }));
    const authCode2 = new URL(ok2.headers.get("Location")!).searchParams.get("code")!;
    const tok = await n.call("/token", form({ grant_type: "authorization_code", code: authCode2, client_id, redirect_uri: redirect, code_verifier: verifier, resource: `${ORIGIN}/mcp` }));
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
    expect(t.token_type).toBe("Bearer");
    expect(t.scope).toBe("assistant");

    const list = await n.call("/mcp", rpc("tools/list", {}, t.access_token));
    expect(list.status).toBe(200);
    const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["list_boards", "create_card", "memory_recall", "notes_search", "note_write"]));

    const r1 = await n.call("/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }));
    const t2 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect((await n.call("/mcp", rpc("ping", {}, t2.access_token))).status).toBe(200);
    // Rotated: the old refresh token is dead.
    const r2 = await n.call("/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }));
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toBe("invalid_grant");

    // Kept by hash, and only for this user.
    const file = await Bun.file(join(n.dir, "oauth.json")).text();
    expect(file).not.toContain(t2.access_token);
    expect(file).not.toContain(t2.refresh_token);
    if (process.platform !== "win32") expect(statSync(join(n.dir, "oauth.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses plain PKCE, no PKCE, and a redirect that isn't the client's", async () => {
    const redirect = "http://localhost/callback";
    const { client_id } = (await (
      await n.call("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })
    ).json()) as { client_id: string };
    const plain = await n.call(`/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:4312/callback", code_challenge: challenge, code_challenge_method: "plain", state: "x" })}`);
    expect(plain.status).toBe(302);
    const to = new URL(plain.headers.get("Location")!);
    // A loopback redirect on another port is the same one.
    expect(to.port).toBe("4312");
    expect(to.searchParams.get("error")).toBe("invalid_request");
    const elsewhere = await n.call(`/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
    expect(elsewhere.status).toBe(400);
    const reg = await n.call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    expect(reg.status).toBe(400);
  });

  it("takes only a few wrong codes", async () => {
    const store = new OAuthStore(join(n.dir, "limit.json"));
    for (let i = 0; i < 5; i++) expect(store.spendApproval("ZZZZ-ZZZZ")).toBe(false);
    const good = store.newApproval();
    expect(() => store.spendApproval(good)).toThrow(/too many/);
  });

  it("checks redirects and client document hosts", () => {
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1/callback")).toBe(true);
    expect(redirectAllowed("app.corkboard:/oauth")).toBe(true);
    expect(redirectAllowed("http://example.com/cb")).toBe(false);
    expect(redirectAllowed("javascript:alert(1)")).toBe(false);
    expect(sameRedirect("http://localhost/callback", "http://localhost:51234/callback")).toBe(true);
    expect(sameRedirect("http://localhost/callback", "http://localhost:51234/other")).toBe(false);
    expect(sameRedirect("https://claude.ai/api/mcp/auth_callback", "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
    for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.100.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(publicAddress(a)).toBe(false);
    for (const a of ["160.79.104.10", "1.1.1.1", "2606:4700::1111"]) expect(publicAddress(a)).toBe(true);
  });

  it("names its origin from Host when it isn't given one", () => {
    expect(originOf(new Request("http://127.0.0.1:8787/x", { headers: { Host: "me.tail1234.ts.net" } }))).toBe("https://me.tail1234.ts.net");
    expect(originOf(new Request("http://127.0.0.1:8787/x"))).toBe("http://127.0.0.1:8787");
  });
});

describe("grants on every node of the account", () => {
  it("refresh on another node, rotated and revoked for all, a CLI's token shared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "corkboard-grants-"));
    dirs.push(dir);
    // The account's object, its changes landing when flushed, as a relay's would.
    const object = new Map<string, unknown>();
    let queue: CardChange[] = [];
    const shared: Shared = { cards: () => [...object].map(([id, row]) => ({ id, row })), change: (...c) => void queue.push(...c) };
    const flush = () => {
      for (const c of queue) if (c.t === "card") object.set(c.card, c.set.row);
      queue = [];
    };
    const laptop = new OAuthStore(join(dir, "laptop.json"), shared);
    const desktop = new OAuthStore(join(dir, "desktop.json"), shared);
    const origin = "https://relay.test/n/abc";
    const redirect = "https://claude.ai/api/mcp/auth_callback";

    const { client_id } = laptop.register({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) as { client_id: string };
    const consent = await laptop.request(new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" }), origin);
    const code = new URL(laptop.approve(consent, origin)).searchParams.get("code")!;
    const t = await laptop.token(new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier }), undefined, origin);
    // A token minted by `serve token`, another process, with no object.
    const phone = new OAuthStore(join(dir, "laptop.json")).mint("phone", 30);
    expect(laptop.verify(phone, origin)?.scope).toBe("owner");
    flush();

    // The laptop gone, claude.ai's hourly token isn't the desktop's, its refresh token is.
    expect(desktop.verify(t.access_token, origin)).toBeUndefined();
    expect(desktop.verify(phone, origin)?.scope).toBe("owner");
    const t2 = await desktop.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }), undefined, origin);
    expect(desktop.verify(t2.access_token, origin)?.scope).toBe("assistant");
    flush();
    // Rotated for all.
    await expect(laptop.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }), undefined, origin)).rejects.toThrow("refresh token is wrong");
    const t3 = await laptop.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id }), undefined, origin);
    flush();

    // Revoked by `serve revoke` on the desktop: gone there before it lands, then everywhere.
    const grant = desktop.grants().find((g) => g.name === "phone")!;
    expect(new OAuthStore(join(dir, "desktop.json")).revoke(grant.id)).toBe(true);
    expect(desktop.verify(phone, origin)).toBeUndefined();
    expect(desktop.verify(phone, origin)).toBeUndefined();
    flush();
    expect(laptop.verify(phone, origin)).toBeUndefined();
    expect(laptop.grants().map((g) => g.name)).toEqual(["Claude"]);
    // Never given again.
    flush();
    expect(desktop.verify(phone, origin)).toBeUndefined();
    expect(laptop.verify(t3.access_token, origin)?.scope).toBe("assistant");
  });
});

describe("the node's MCP tools, over replicas", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let token: string;
  beforeAll(async () => {
    n = await setup();
    token = n.oauth.mint("test", 1, "assistant");
    // The laptop has a card already, as push-board would put it.
    await n.laptop.change({ t: "card", card: "TASK-1", set: { title: "Ship the node", status: "ready", labels: [], dependencies: [], created: "2026-11-01T00:00:00Z", updated: "2026-11-01T00:00:00Z" } });
    await n.laptop.push();
    await n.replicas.syncAll();
  });
  afterAll(() => n.stop());
  const tool = async (name: string, args: Record<string, unknown>) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, token)));

  it("lists, claims, logs and makes cards, and the laptop sees them", async () => {
    expect(JSON.parse((await tool("list_boards", {})).text)).toEqual([{ key: "proj", name: "proj", root: null, cards: 1 }]);
    const next = JSON.parse((await tool("next_card", { board: "proj" })).text);
    expect(next.id).toBe("TASK-1");
    expect(next.agent).toBe("assistant");
    expect(next.status).toBe("doing");
    await tool("log", { board: "proj", id: "task-1", note: "half way" });
    const made = JSON.parse((await tool("create_card", { board: "proj", title: "Follow up", parent: "TASK-1" })).text);
    expect(made.id).toMatch(/^TASK-[0-9A-HJKMNP-TV-Z]{4}$/);
    const read = JSON.parse((await tool("read_card", { board: "proj", id: "TASK-1" })).text);
    expect(read.log).toContain("half way");
    expect(read.log).toContain(`follow-up: ${made.id}`);
    const err = await tool("update_card", { board: "proj", id: made.id, agent_state: "working" });
    expect(err.error).toBe(true);
    expect(err.text).toContain("claim it first");
    expect((await tool("read_card", { board: "proj", id: "TASK-9" })).error).toBe(true);

    await n.replicas.settled();
    await n.laptop.pull();
    // Beside the cards, the claim's lease (leases.ts).
    const cards = n.laptop.cards().filter((c) => isCard(c.id));
    expect(cards.map((c) => c.id).sort()).toEqual(["TASK-1", made.id].sort());
    const first = cards.find((c) => c.id === "TASK-1")!;
    expect(first.agent).toBe("assistant");
    expect(first.log.map((e) => e.note)).toEqual(["claimed", "half way", `follow-up: ${made.id}`]);
  });

  it("writes and finds notes and memory", async () => {
    const note = JSON.parse((await tool("note_write", { kind: "project", title: "Node rollout", body: "Funnel in front of the node.\nCaddy on the VPS." })).text);
    expect(note.id).toBe("node-rollout");
    expect(note.version).toBe(1);
    const stale = await tool("note_write", { id: "node-rollout", kind: "project", title: "Node rollout", body: "x", version: 0 });
    expect(stale.error).toBe(true);
    expect((await tool("note_write", { id: "soul", kind: "memory", title: "Soul", body: "x" })).text).toContain("only the user");
    expect((await tool("note_write", { kind: "goal", title: "Secret goal", body: "x" })).error).toBe(true);
    await tool("note_append", { id: "node-rollout", text: "Tested on the droplet." });
    await tool("memory_remember", { text: "Decided the phone reads boards from the relay directly." });

    const found = JSON.parse((await tool("notes_search", { query: "funnel" })).text);
    expect(found[0].id).toBe("node-rollout");
    expect(found[0].snippet).toContain("[Funnel]");
    const recall = JSON.parse((await tool("memory_recall", { query: "relay phone" })).text);
    expect(recall[0].type).toBe("entry");
    const grep = JSON.parse((await tool("memory_grep", { text: "droplet" })).text);
    expect(grep[0].where).toMatch(/^node-rollout:/);
    const log = JSON.parse((await tool("memory_log", { when: "today" })).text);
    expect(log.entries).toHaveLength(1);
    const ctx = (await tool("memory_context", {})).text;
    expect(ctx).toContain("# Memory: assistant");
    expect(ctx).toContain("phone reads boards");

    // The records are the plan's: note:<id> (or note.<id>, until merge.ts takes colons).
    expect(n.replicas.get("brain", "assistant")!.state.cards[noteRecord("node-rollout")]).toBeDefined();
  });
});

describe("a board's own records", () => {
  it("keeps two devices' extra keys, the board's settings, and ids that don't collide", async () => {
    const n = await setup();
    // A card as push-board brought it, with a whole extra.
    await n.laptop.change({ t: "card", card: "TASK-1", set: { title: "Old", status: "ready", extra: { worktree: "/w" }, created: "2026-11-01T00:00:00Z" } });
    await n.laptop.push();
    await n.replicas.syncAll();
    expect(n.data.card("proj", "TASK-1").extra).toEqual({ worktree: "/w" });
    // At once: the node sets a branch, the laptop (not having seen it) a media list.
    await n.data.updateCard("proj", "TASK-1", { extra: { worktree: "/w", branch: "card/task-1" } });
    await n.laptop.change({ t: "card", card: "TASK-1", set: { "extra.media": [{ id: "m1" }] } });
    await n.laptop.push();
    await n.replicas.settled();
    await n.replicas.syncAll();
    expect(n.data.card("proj", "TASK-1").extra).toEqual({ worktree: "/w", branch: "card/task-1", media: [{ id: "m1" }] });
    // Taking a key out.
    await n.data.updateCard("proj", "TASK-1", { extra: { branch: "card/task-1", media: [{ id: "m1" }] } });
    expect(n.data.card("proj", "TASK-1").extra).toEqual({ branch: "card/task-1", media: [{ id: "m1" }] });

    await n.data.putBoard("proj", { name: "Project", root: "/home/me/proj", commit: "abc" });
    expect(n.data.board("proj")).toEqual({ name: "Project", root: "/home/me/proj", commit: "abc" });
    expect(n.data.boards()).toEqual([{ key: "proj", name: "Project", root: "/home/me/proj", cards: 1 }]);
    expect(n.data.cards("proj", true).map((c) => c.id)).toEqual(["TASK-1"]);

    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newCardId([...ids]));
    expect(ids.size).toBe(200);
    expect(newCardId(["BUG-1", "BUG-2", "TASK-3"])).toMatch(/^BUG-/);
    await n.stop();
  });
});

describe("the app's operations, for another bridge", () => {
  it("answers the owner on /app, and nobody else", async () => {
    const n = await setup();
    const asked: unknown[] = [];
    let served = false;
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, app: () => (served ? async (op, args) => (asked.push([op, args]), op === "brains_holds" ? undefined : { op }) : undefined) });
    const as = (token: string, body: unknown, address = "127.0.0.1") =>
      app(new Request(`${ORIGIN}/app`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), { requestIP: () => ({ address }) });
    const owner = n.oauth.mint("dev bridge", 1, "owner");
    expect((await as(owner, { op: "brains_get", args: [] })).status).toBe(404);
    served = true;
    expect(await (await as(owner, { op: "brains_notes", args: ["assistant"] })).json()).toEqual({ value: { op: "brains_notes" } });
    expect(await (await as(owner, { op: "brains_holds" })).json()).toEqual({});
    expect((await as(owner, { op: "boards_get" })).status).toBe(400);
    expect(await (await as(owner, { op: "board_boards" })).json()).toEqual({ value: { op: "board_boards" } });
    // Not from another machine, nor through the tunnel (no peer), even the owner.
    expect((await as(owner, { op: "brains_get" }, "192.168.1.5")).status).toBe(404);
    expect((await app(new Request(`${ORIGIN}/app`, { method: "POST", headers: { Authorization: `Bearer ${owner}` }, body: "{}" }))).status).toBe(404);
    expect((await as(n.oauth.mint("session", 1, "assistant"), { op: "brains_get" })).status).toBe(404);
    expect((await app(new Request(`${ORIGIN}/app`, { method: "POST" }))).status).toBe(401);
    expect(asked).toEqual([["brains_notes", ["assistant"]], ["brains_holds", []], ["board_boards", []]]);
    await n.stop();
  });

  it("streams the boards' events to the owner on loopback", async () => {
    const n = await setup();
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, appEvents: () => boardEvents(n) });
    const owner = n.oauth.mint("dev bridge", 1, "owner");
    const get = (address: string) => app(new Request(`${ORIGIN}/app/events`, { headers: { Authorization: `Bearer ${owner}` } }), { requestIP: () => ({ address }) });
    expect((await get("10.0.0.2")).status).toBe(404);
    const res = await get("::1");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(": up\n\n");
    const c = await n.data.createCard("proj", { title: "Streamed" });
    expect(JSON.parse((await reader.read()).value!.replace(/^data: /, ""))).toMatchObject({ key: "proj", event: { type: "card", card: { id: c.id, title: "Streamed" } } });
    await reader.cancel();
    await n.stop();
  });
});

describe("the phone's API", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let auth: Record<string, string>;
  beforeAll(async () => {
    n = await setup();
    auth = { Authorization: `Bearer ${n.oauth.mint("phone", 30)}`, "Content-Type": "application/json" };
  });
  afterAll(() => n.stop());
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await n.call(`/api/node/${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("wants a token", async () => {
    expect((await n.call("/api/node/boards")).status).toBe(401);
    expect((await n.call("/health")).status).toBe(200);
  });

  it("makes, changes and logs cards", async () => {
    const made = await api("POST", "boards/proj/cards", { title: "From the phone", priority: "high" });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect((await api("PATCH", `boards/proj/cards/${id.toLowerCase()}`, { status: "doing" })).body.status).toBe("doing");
    expect((await api("PATCH", `boards/proj/cards/${id}`, { nonsense: 1 })).status).toBe(400);
    expect((await api("POST", `boards/proj/cards/${id}/log`, { note: "on the train" })).body.who).toBe("phone");
    const boards = (await api("GET", "boards")).body;
    expect(boards[0].key).toBe("proj");
    expect(boards[0].cards[0].title).toBe("From the phone");
    const withLog = (await api("GET", "boards/proj/cards?log=1")).body;
    expect(withLog[0].log[0].note).toBe("on the train");
    expect((await api("GET", "boards/nope/cards")).status).toBe(404);
  });

  it("reads and writes brains, and searches them", async () => {
    expect((await api("PUT", "brains/assistant/notes/user", { kind: "person", title: "Matthew", body: "Likes monospace." })).status).toBe(200);
    expect((await api("PUT", "brains/assistant/notes/soul", { kind: "memory", title: "Soul", body: "Be kind." })).status).toBe(200);
    expect((await api("POST", "brains/assistant/remember", { text: "Walked the dog at noon." })).status).toBe(201);
    expect((await api("GET", "brains")).body[0]).toMatchObject({ name: "assistant", default: true, notes: 2, entries: 1 });
    expect((await api("GET", "brains/assistant/notes?q=monospace")).body[0].id).toBe("user");
    expect((await api("GET", "brains/assistant/notes/user")).body.body).toBe("Likes monospace.");
    expect((await api("GET", "brains/assistant/recall?q=dog")).body[0].snippet).toContain("dog");
    expect((await api("GET", "brains/assistant/entries")).body).toHaveLength(1);
    const status = (await api("GET", "status")).body;
    expect(status.objects.map((o: { kind: string; name: string }) => `${o.kind}/${o.name}`)).toEqual(["board/proj", "brain/assistant"]);
    expect(status.calendar).toBe(false);
  });

  it("adds a log written elsewhere once, whatever else is sent with it", async () => {
    const e = (key: string, text: string, at = "2030-01-02T17:00:00Z") => ({ day: "2030-01-02", at, who: "vault", text, key });
    await n.data.importEntries("assistant", [{ from: "worker:1", at: "2030-01-02T16:00:00Z", day: "2030-01-02", who: "vault", text: "Moved already." }]);
    expect((await api("POST", "brains/assistant/entries", { entries: [e("a", "First."), e("old", "Moved already.", "2030-01-02T16:00:00Z")] })).body).toEqual({ added: 1 });
    expect((await api("POST", "brains/assistant/entries", { entries: [e("z", "Earlier.", "2030-01-02T15:00:00Z"), e("a", "First.")] })).body).toEqual({ added: 1 });
    expect(n.data.entries("assistant", "2030-01-02").map((x) => x.text)).toEqual(["Earlier.", "Moved already.", "First."]);
    expect((await api("POST", "brains/assistant/entries", { entries: [{ ...e("b", "x"), at: "soon" }] })).status).toBe(400);
  });

  it("writes an accepted plan to the calendar when one is connected", async () => {
    expect((await api("POST", "calendar", { date: "2030-01-02", day: { blocks: [] } })).status).toBe(409);
    const calls: { method: string; url: string; body?: any }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined });
      if (url.includes("oauth2")) return Response.json({ access_token: "g" });
      if ((init?.method ?? "GET") === "GET") return Response.json({ items: [{ id: "old" }] });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "e" });
    };
    const app = node({
      data: n.data,
      search: n.search,
      oauth: n.oauth,
      origin: ORIGIN,
      fetch: fake,
      calendar: () => ({ client_id: "c", client_secret: "s", refresh: "r", calendar: "cal@group", timezone: "UTC" }),
    });
    const blocks = [
      { id: "a", start: 540, stop: 600, title: "Deep: the node", kind: "work" },
      { id: "b", start: 600, stop: 630, title: "Standup", kind: "fixed" },
    ];
    const res = await app(new Request(`${ORIGIN}/api/node/calendar`, { method: "POST", headers: auth, body: JSON.stringify({ date: "2030-01-02", day: { blocks } }) }));
    expect(await res.json()).toEqual({ blocks: 1 });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE", "POST", "POST"]);
    expect(calls[3].body.summary).toBe("Deep: the node");
    expect(calls[4].body.summary).toBe("✅ Plan approved");
  });
});

describe("a session's hooks", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let auth: Record<string, string>;
  beforeAll(async () => {
    n = await setup();
    auth = { Authorization: `Bearer ${n.oauth.mint("laptop", 30)}`, "Content-Type": "application/json" };
    await n.data.putNote("assistant", "user", { kind: "person", title: "Matthew", body: "Likes monospace." });
    await n.data.putNote("assistant", "goal-ship", { kind: "goal", title: "Ship", body: "The brains' own." });
  });
  afterAll(() => n.stop());
  const post = (body: unknown) => n.call("/memory/episodes", { method: "POST", headers: auth, body: JSON.stringify(body) });

  it("start a session with the brain's context", async () => {
    expect((await n.call("/memory/context")).status).toBe(401);
    const res = await n.call("/memory/context?budget=5000", { headers: auth });
    expect(res.headers.get("Content-Type")).toContain("markdown");
    const text = await res.text();
    expect(text).toContain("Likes monospace.");
    expect(text).not.toContain("The brains' own.");
    expect((await n.call("/memory/context?brain=nope", { headers: auth })).status).toBe(404);
  });

  it("give a brain's own token its goals, and only its brain", async () => {
    const own = { Authorization: `Bearer ${n.oauth.mint("pepper", 30, "assistant", "assistant")}`, "Content-Type": "application/json" };
    expect(await (await n.call("/memory/context", { headers: own })).text()).toContain("The brains' own.");
    expect((await n.call("/memory/context?brain=other", { headers: own })).status).toBe(403);
    const found = await toolText(await n.call("/mcp?tools=memory", rpc("tools/call", { name: "notes_search", arguments: { kind: "goal" } }, own.Authorization.slice(7))));
    expect(JSON.parse(found.text).map((x: { id: string }) => x.id)).toEqual(["goal-ship"]);
  });

  it("keep a session's transcript once, the newest while it's unread", async () => {
    let added = 0;
    n.episodes.onAdded = () => void added++;
    const first = await post({ session: "s1", trigger: "compact", transcript: "{\"a\":1}\n" });
    expect(first.status).toBe(201);
    expect((await post({ session: "s1", trigger: "compact", transcript: "{\"a\":1}\n" })).status).toBe(200);
    const grown = (await (await post({ session: "s1", transcript: "{\"a\":1}\n{\"b\":2}\n" })).json()) as { id: string };
    await post({ session: "s2", transcript: "{}\n" });
    expect(added).toBe(3);
    const list = (await (await n.call("/memory/episodes?pending=1", { headers: auth })).json()) as { id: string; session: string; trigger: string }[];
    expect(list.map((e) => e.session).sort()).toEqual(["s1", "s2"]);
    expect(list.find((e) => e.session === "s1")!.trigger).toBe("end");
    const one = (await (await n.call(`/memory/episodes/${grown.id}`, { headers: auth })).json()) as { transcript: string };
    expect(one.transcript).toContain("\"b\":2");
    expect((await post({ session: "", transcript: "x" })).status).toBe(400);
    expect(n.episodes.waiting()).toEqual(["assistant"]);
  });
});

describe("the consolidator", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  // A minute past the 4am (UTC) the real day turned over at, so the hours
  // the tests move on never turn it over a second time and bring a rollup
  // due, and it's behind the real time: what the log stamps with that stays
  // on the day rolled up, and after what the clock stamps.
  let clock = Math.floor((Date.now() - 4 * 3600_000) / 86_400_000) * 86_400_000 + 4 * 3600_000 + 60_000;
  let answer: string | Error = "";
  let leading = true;
  const asked: { prompt: string; input: string }[] = [];
  let c: Consolidator;
  const ran: string[] = [];
  beforeAll(async () => {
    n = await setup();
    c = new Consolidator({
      data: n.data,
      episodes: n.episodes,
      after: async (brain) => void ran.push(brain),
      now: () => clock,
      leads: async () => leading,
      think: async (prompt, input) => {
        asked.push({ prompt, input });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
  });
  afterAll(() => n.stop());
  const said = (who: string, text: string, at = new Date(clock).toISOString()) =>
    JSON.stringify({ type: who, timestamp: at, message: { content: [{ type: "text", text }] } }) + "\n";
  const first = said("user", "Remember that I like monospace.") + said("assistant", "Noted.");

  it("read an episode once it's quiet, into the log once", async () => {
    n.episodes.add("assistant", { session: "s1", agent: "assistant", trigger: "end", transcript: first });
    answer = "- Matthew likes monospace.\n  Everywhere.\n- Nothing else.";
    await c.tick();
    expect(asked.length).toBe(0);
    clock += QUIET + 1;
    await c.tick();
    expect(asked.length).toBe(1);
    expect(asked[0].input).toContain("I like monospace");
    const log = n.data.entries("assistant");
    expect(log.map((e) => e.text)).toEqual(["Matthew likes monospace.\n  Everywhere.", "Nothing else."]);
    expect(log[0].who).toBe("assistant");
    expect(n.episodes.list("assistant", 10, true)).toEqual([]);
    expect(ran).toEqual(["assistant"]);
    await c.tick();
    expect(asked.length).toBe(1);
  });

  it("read only what a session added since", async () => {
    clock += 60_000;
    n.episodes.add("assistant", { session: "s1", agent: "assistant", trigger: "end", transcript: first + said("user", "And tabs, not spaces.") });
    answer = "NOTHING";
    clock += QUIET + 1;
    await c.tick();
    expect(asked.length).toBe(2);
    expect(asked[1].input).toContain("tabs, not spaces");
    expect(asked[1].input).not.toContain("I like monospace");
    expect(n.data.entries("assistant").length).toBe(2);
  });

  it("roll the log up into the memory once a day has turned over", async () => {
    clock += 86_400_000;
    answer = "===MEMORY===\n- Likes monospace, and tabs.\n===SOUL-SUGGESTIONS===\n- Be terse.";
    // Another node leads, so it's that one's to do.
    leading = false;
    await c.tick();
    expect(asked.length).toBe(2);
    leading = true;
    await c.tick();
    expect(asked.length).toBe(3);
    expect(asked[2].input).toContain("Matthew likes monospace.");
    expect(n.data.note("assistant", "memory")!.body).toBe("- Likes monospace, and tabs.\n");
    expect(n.data.entries("assistant").at(-1)!.text).toBe("Suggested for the soul: Be terse.");
    expect(n.data.rolled("assistant")).toBe(n.data.dayOf(new Date(clock - 86_400_000).toISOString()));
    await c.tick();
    expect(asked.length).toBe(3);
  });

  it("wait longer after each run that failed", async () => {
    n.episodes.add("assistant", { session: "s2", agent: "assistant", trigger: "end", transcript: said("user", "Something new.") });
    answer = new Error("rate limited");
    clock += QUIET + 1;
    await c.tick();
    expect(asked.length).toBe(4);
    clock += 30 * 60_000;
    await c.tick();
    expect(asked.length).toBe(4);
    clock += 31 * 60_000;
    await c.tick();
    expect(asked.length).toBe(5);
    expect(n.episodes.meta("assistant", "consolidate_failures")).toBe("2");
    answer = "- Something new.";
    clock += 2 * 3600_000 + 1;
    await c.tick();
    expect(n.episodes.list("assistant", 10, true)).toEqual([]);
    expect(n.episodes.meta("assistant", "consolidate_failures")).toBe("0");
  });
});

describe("episodes handed to the leader", () => {
  it("give a session's new part to the node that leads, which reads it", async () => {
    const root = newRoot();
    const shared = relay();
    const kept = new Map<string, Uint8Array>();
    const blobs: Blobs = {
      putBlob: async (id, b) => void kept.set(id, b),
      getBlob: async (id) => kept.get(id) ?? Promise.reject(Object.assign(new Error("no such blob"), { status: 404 })),
      deleteBlob: async (id) => void kept.delete(id),
    };
    const objects = listObjects(root, { boards: [], brains: ["assistant"] });
    let clock = Date.now();
    const said = (text: string) => JSON.stringify({ type: "user", timestamp: new Date(clock).toISOString(), message: { content: [{ type: "text", text }] } }) + "\n";
    const device = async (name: string, leads: { now: boolean }) => {
      const replicas = await Replicas.open({ objects, transport: as(shared, name), device: name });
      await replicas.start({ live: false });
      const data = new Data(replicas, "UTC");
      const episodes = new Episodes();
      const asked: string[] = [];
      const c = new Consolidator({
        data,
        episodes,
        now: () => clock,
        leads: async () => leads.now,
        handoff: new Handoff({ replicas, episodes, blobs }),
        think: async (_, input) => (asked.push(input), "- " + name + " read it."),
      });
      return { replicas, data, episodes, asked, c };
    };
    const away = { now: true };
    const laptop = await device("laptop", away);
    const desktop = await device("desktop", { now: true });

    // The leader away, the laptop reads its own.
    const first = said("Tabs, not spaces.");
    laptop.episodes.add("assistant", { session: "s1", agent: "assistant", trigger: "end", transcript: first });
    clock += QUIET + 1;
    await laptop.c.tick();
    expect(laptop.asked.length).toBe(1);

    // Back, the desktop's given the rest of the session, sealed.
    away.now = false;
    clock += 60_000;
    laptop.episodes.add("assistant", { session: "s1", agent: "assistant", trigger: "end", transcript: first + said("And monospace.") });
    clock += QUIET + 1;
    await laptop.c.tick();
    expect(laptop.asked.length).toBe(1);
    expect(laptop.episodes.list("assistant", 10, true)).toEqual([]);
    expect(kept.size).toBe(1);
    expect(new TextDecoder().decode([...kept.values()][0])).not.toContain("monospace");
    await laptop.replicas.settled();

    await desktop.replicas.syncAll();
    await desktop.c.tick();
    expect(desktop.episodes.list("assistant", 10, true).length).toBe(1);
    expect(kept.size).toBe(0);
    clock += QUIET + 1;
    await desktop.c.tick();
    expect(desktop.asked.length).toBe(1);
    expect(desktop.asked[0]).toContain("And monospace.");
    expect(desktop.asked[0]).not.toContain("Tabs, not spaces.");
    expect(desktop.data.entries("assistant").map((e) => e.text)).toEqual(["laptop read it.", "desktop read it."]);

    // Taken once.
    await desktop.c.tick();
    expect(desktop.episodes.list("assistant", 10).length).toBe(1);
    await laptop.replicas.stop();
    await desktop.replicas.stop();
  });
});

describe("recall by meaning", () => {
  // A word's bucket for each word, cats and dogs both pets, normalized.
  const SAME: Record<string, string> = { cat: "pet", cats: "pet", dog: "pet", dogs: "pet", kitten: "pet" };
  let embedded = 0;
  const embed: Embed = async (texts) =>
    texts.map((t) => {
      embedded++;
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[[...(SAME[w] ?? w)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });

  it("find what's meant, each text embedded once for the account", async () => {
    // The laptop ran the session and wrote; the desktop reads.
    const root = newRoot();
    const shared = relay();
    const objects = listObjects(root, { boards: [], brains: ["assistant"] });
    const device = async (name: string) => {
      const replicas = await Replicas.open({ objects, transport: as(shared, name), device: name });
      await replicas.start({ live: false });
      const data = new Data(replicas, "UTC");
      return { replicas, data, search: new Search(data, new LocalEmbedder(data, embed, "fake")) };
    };
    const laptop = await device("laptop");
    await laptop.data.putNote("assistant", "home", { kind: "memory", title: "Home", body: "Matthew has a kitten called Miso." });
    await laptop.data.remember("assistant", "assistant", "Shipped the release on Friday.");
    await laptop.search.share("assistant");
    expect(embedded).toBe(2);
    expect(laptop.data.vectorHashes("assistant").length).toBe(2);
    await laptop.replicas.settled();

    const desktop = await device("desktop");
    const hits = await desktop.search.recall("assistant", "pets", 5);
    expect(hits[0].id).toBe("home");
    expect(embedded).toBe(3);

    // A text changed: its new vector made, its old one dropped.
    await laptop.data.putNote("assistant", "home", { kind: "memory", title: "Home", body: "Matthew has two dogs." });
    await laptop.search.share("assistant");
    expect(embedded).toBe(4);
    expect(laptop.data.vectorHashes("assistant").length).toBe(2);
    await laptop.replicas.settled();
    await desktop.replicas.syncAll();
    expect((await desktop.search.recall("assistant", "cats", 5))[0].snippet).toContain("two dogs");
    expect(embedded).toBe(5);
    await laptop.replicas.stop();
    await desktop.replicas.stop();
  });

  it("keep a vector to a byte a dimension", () => {
    const v = Float32Array.from([0.6, -0.8, 0, 0.001]);
    const back = dequantize(quantize(v));
    v.forEach((x, i) => expect(Math.abs(back[i] - x)).toBeLessThan(0.005));
  });

  it("embed a long note in pieces, each with its title", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(15)}`).join("\n\n");
    const p = pieces(`Title\n\n${body}`);
    expect(p.length).toBeGreaterThan(1);
    expect(p.every((x) => x.startsWith("Title\n\n") && x.length <= 1500 + 10)).toBe(true);
    expect(pieces("short")).toEqual(["short"]);
  });
});

describe("the node's objects, from the account's index", () => {
  const root = newRoot();
  const shared = relay();
  const card = (title: string) => ({ t: "card" as const, card: "TASK-1", set: { title, status: "ready", labels: [], dependencies: [], created: "2026-11-01T00:00:00Z", updated: "2026-11-01T00:00:00Z" } });
  const openIndex = (device: string) => Replica.open({ transport: as(shared, device), key: indexKey(root), object: indexId(root), device });
  let index: Replica;
  let replicas: Replicas;
  let brainKey: Uint8Array;
  beforeAll(async () => {
    // The laptop pushed a board, and a brain it then moved onto a random
    // key (as sharing does), and listed both.
    const laptop = await openIndex("laptop");
    const [home] = listObjects(root, { boards: ["home"], brains: [] });
    const board = await Replica.open({ transport: as(shared, "laptop"), key: home.key, object: home.object, device: "laptop" });
    await board.change(card("Water the plants"));
    await board.push();
    await remember(laptop, { object: home.object, kind: "board", name: "home", epoch: 0 });
    const [notes] = listObjects(root, { boards: [], brains: ["notes"] });
    const brain = await Replica.open({ transport: as(shared, "laptop"), key: notes.key, object: notes.object, device: "laptop" });
    await brain.change({ t: "card", card: noteRecord("user"), set: { kind: "person", title: "Matthew", body: "Likes monospace." } });
    brainKey = random(32);
    await brain.rekey(brainKey);
    await remember(laptop, { object: notes.object, kind: "brain", name: "notes", epoch: brain.currentEpoch, key: b64url(brainKey) });
    await laptop.push();

    index = await openIndex("node");
    await index.pull();
    replicas = await Replicas.open({ objects: listObjects(root, { boards: [], brains: [] }, index), transport: as(shared, "node"), device: "node", index });
    await replicas.start({ live: false });
  });
  afterAll(() => replicas.stop());

  it("serves what the index lists, one on a random key among them", async () => {
    expect(replicas.objects().map((o) => `${o.kind}/${o.name}@${o.epoch}`).sort()).toEqual(["board/home@0", "brain/notes@1"]);
    expect(replicas.get("board", "home")!.cards()[0].title).toBe("Water the plants");
    expect(replicas.get("brain", "notes")!.cards().find((c) => c.id === noteRecord("user"))!.body).toBe("Likes monospace.");
    // Its writes go out under the new key, and the laptop reads them.
    await replicas.change("brain", "notes", { t: "card", card: noteRecord("dog"), set: { kind: "person", title: "Dog", body: "Walks at noon." } });
    await replicas.settled();
    const [notes] = listObjects(root, { boards: [], brains: [] }, index).filter((o) => o.kind === "brain");
    const other = await Replica.open({ transport: as(shared, "laptop"), key: brainKey, epoch: 1, object: notes.object, device: "laptop" });
    await other.pull();
    expect(other.cards().find((c) => c.id === noteRecord("dog"))!.title).toBe("Dog");
  });

  it("narrows the index to the names given, and lists a new one when it first writes it", async () => {
    expect(listObjects(root, { boards: ["home"], brains: [] }, index).map((o) => o.name)).toEqual(["home"]);
    const fresh = await Replicas.open({ objects: listObjects(root, { boards: ["errands"], brains: [] }, index), transport: as(shared, "node"), device: "node", index });
    expect(fresh.objects().map((o) => `${o.kind}/${o.name}@${o.epoch}`)).toEqual(["board/errands@0"]);
    await fresh.change("board", "errands", card("Buy stamps"));
    await fresh.settled();
    const laptop = await openIndex("laptop");
    await laptop.pull();
    expect(entries(laptop).find((e) => e.name === "errands")).toMatchObject({ kind: "board", epoch: 0 });
    await fresh.stop();
  });

  it("compacts a log of its own once it's worth it, and lives through a refusal", async () => {
    const home = replicas.objects("board")[0];
    shared.state.refuse = true;
    shared.state.pad = 5000;
    await replicas.syncAll();
    expect(shared.state.logs.get(home.object)!.snapshot).toBeUndefined();
    shared.state.refuse = false;
    await replicas.syncAll();
    shared.state.pad = 0;
    expect(shared.state.logs.get(home.object)!.snapshot?.upTo).toBe(1);
    expect(shared.state.logs.get(index.object)!.snapshot).toBeDefined();
    // A device new to the board starts from the snapshot.
    const late = await Replica.open({ transport: as(shared, "phone"), key: home.key, object: home.object, device: "phone" });
    await late.pull();
    expect(late.cards()[0].title).toBe("Water the plants");
  });
});

describe("an account only on this machine", () => {
  const root = newRoot();
  const shared = relay();
  // The replicas' disk, kept across the node starting again with a relay.
  const disk = new Map<string, ReplicaStore>();
  const storeOf = (object: string) => disk.get(object) ?? (disk.set(object, memoryStore()), disk.get(object)!);
  const openIndex = (transport: LogTransport, device: string) => Replica.open({ transport, key: indexKey(root), object: indexId(root), device, store: storeOf(indexId(root)) });

  it("keeps a brain written with no relay, and hands it whole to a second device once published", async () => {
    const index = await openIndex(offline, "laptop");
    const local = await Replicas.open({ objects: listObjects(root, { boards: [], brains: ["assistant"] }, index), transport: offline, device: "laptop", store: storeOf, index });
    await local.start();
    expect(local.online).toBe(false);
    const data = new Data(local, "UTC");
    await data.putNote("assistant", "user", { kind: "person", title: "Matthew", body: "Likes monospace." });
    await data.remember("assistant", "laptop", "Chose local-first memory.");
    await data.remember("assistant", "laptop", "Embeddings stay on the device.");
    await local.settled();
    expect(shared.state.logs.size).toBe(0);
    expect(local.status()[0]).toMatchObject({ name: "assistant", pending: 3, error: null, synced: null });
    expect(entries(index).map((e) => e.name)).toEqual(["assistant"]);
    await local.stop();

    // Published: the same stores, now over the relay; the queues go out.
    const online = await openIndex(as(shared, "laptop"), "laptop");
    await online.push();
    const laptop = await Replicas.open({ objects: listObjects(root, { boards: [], brains: [] }, online), transport: as(shared, "laptop"), device: "laptop", store: storeOf, index: online });
    await laptop.start({ live: false });
    expect(laptop.status()[0]).toMatchObject({ name: "assistant", pending: 0, error: null });
    await laptop.stop();

    const phoneIndex = await Replica.open({ transport: as(shared, "phone"), key: indexKey(root), object: indexId(root), device: "phone" });
    await phoneIndex.pull();
    const phone = await Replicas.open({ objects: listObjects(root, { boards: [], brains: [] }, phoneIndex), transport: as(shared, "phone"), device: "phone", index: phoneIndex });
    await phone.start({ live: false });
    const there = new Data(phone, "UTC");
    expect(there.note("assistant", "user")!.body).toBe("Likes monospace.");
    expect(there.entries("assistant").map((e) => e.text)).toEqual(["Chose local-first memory.", "Embeddings stay on the device."]);
    await phone.stop();
  });
});

describe("a brain made while the node runs", () => {
  it("is kept and listed, has one default, and moves its updated on every change", async () => {
    const n = await setup();
    await n.replicas.add(listObjects(n.root, { boards: [], brains: ["work"] })[0]);
    await n.data.putBrain("assistant", { title: "Assistant", default: true });
    const first = await n.data.putBrain("work", { title: "Work", default: false });
    expect(n.data.brains().map((b) => b.name).sort()).toEqual(["assistant", "work"]);

    const made = await n.data.putBrain("work", { default: true });
    expect(String(made.updated) > String(first.updated)).toBe(true);
    expect(n.data.brains().filter((b) => b.default).map((b) => b.name)).toEqual(["work"]);
    expect(n.data.defaultBrain()).toBe("work");

    await n.data.putBrain("work", { archived: "2026-11-04T00:00:00Z", default: false });
    expect(n.data.defaultBrain()).toBe("assistant");
    await n.stop();
  });
});

describe("memory moved off the Worker", () => {
  // The Worker's move routes (api.ts), over tables kept here, paged a row at a time.
  function worker(tables: Record<string, Record<string, Row[]>>, records: Record<string, unknown>[]) {
    const calls: string[] = [];
    const state = { move: null as null | { account: string; state: string }, purged: false };
    const fetch = async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${path.split("?")[0]}`);
      const url = new URL(path, "https://worker.test");
      if (url.pathname === "/api/brains") return Response.json(records);
      if (url.pathname === "/api/memory/move" && method === "POST") {
        state.move = { account: JSON.parse(String(init.body)).account, state: "moving" };
        return Response.json({ ...state.move, brains: Object.keys(tables) });
      }
      if (url.pathname === "/api/memory/move" && method === "DELETE") return (state.move = null), new Response(null, { status: 204 });
      if (state.move?.state !== "moving") return new Response("not moving", { status: 409 });
      if (url.pathname === "/api/memory/move/done") return (state.purged = true), (state.move.state = "moved"), Response.json(state.move);
      const brain = url.pathname.split("/").pop()!;
      const table = url.searchParams.get("table")!;
      const after = Number(url.searchParams.get("after"));
      const episode = url.searchParams.get("episode");
      const all = (tables[brain][table] ?? []).map((r, i): Row & { _rowid: number } => ({ _rowid: i + 1, ...r })).filter((r) => r._rowid > after && (episode === null || r.episode === episode));
      return Response.json({ rows: all.slice(0, 1), next: all.length > 1 ? all[0]._rowid : null });
    };
    return { fetch, calls, state };
  }
  type Row = Record<string, string | number | null>;
  const tables = (): Record<string, Record<string, Row[]>> => ({
    pepper: {
      notes: [
        { id: "soul", kind: "soul", title: "Soul", body: "be kind", created: "2026-01-01T00:00:00Z", updated: "2026-02-01T00:00:00Z", version: 3 },
        { id: "goals", kind: "goal", title: "Goals", body: "ship", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", version: 1 },
      ],
      entries: [
        { id: 1, at: "2026-03-01T10:00:00Z", day: "2026-03-01", who: "assistant", text: "one" },
        { id: 2, at: "2026-03-01T10:00:00Z", day: "2026-03-01", who: "assistant", text: "two, at the same time" },
      ],
      episodes: [{ id: "ep1", session: "s1", agent: "assistant", trigger: "stop", at: "2026-03-01T11:00:00Z", bytes: 6, parts: 2, consolidated: 1 }],
      episode_parts: [
        { episode: "ep1", seq: 0, text: "abc" },
        { episode: "ep1", seq: 1, text: "def" },
      ],
      consolidated_sessions: [{ session: "s1", through: "2026-03-01T11:00:00Z" }],
      meta: [{ key: "brain", value: "pepper" }, { key: "rolled", value: "2026-03-01" }],
    },
    work: { notes: [], entries: [{ id: 1, at: "2026-03-02T09:00:00Z", day: "2026-03-01", who: "user", text: "late night" }] },
  });
  const target = (n: Awaited<ReturnType<typeof setup>>) => ({
    ...n,
    account: "acct-0123456789abcdefghij",
    addBrain: (name: string) => n.replicas.add(listObjects(n.root, { boards: [], brains: [name] })[0]),
  });

  it("copies every brain's memory and settings, then purges the Worker's", async () => {
    const n = await setup();
    const w = worker(tables(), [{ name: "work", title: "Work", description: "the job", default: true, abilities: [], credentials: [], created: "2026-01-01T00:00:00Z" }]);
    const moved = await moveMemory(target(n), w.fetch, { log: () => {} });
    expect(moved.pepper).toEqual({ notes: 2, entries: 2, episodes: 1 });
    expect(w.state.purged).toBe(true);

    expect(n.data.brain("pepper").title).toBe("Pepper");
    expect(n.data.brain("work")).toMatchObject({ title: "Work", description: "the job" });
    expect(n.data.defaultBrain()).toBe("work");
    expect(n.data.note("pepper", "soul")).toMatchObject({ body: "be kind", version: 3, updated: "2026-02-01T00:00:00Z" });
    expect(n.data.entries("pepper").map((e) => e.text)).toEqual(["one", "two, at the same time"]);
    expect(n.data.entries("work")[0].day).toBe("2026-03-01");
    expect(n.episodes.transcript("pepper", "ep1")).toBe("abcdef");
    expect(n.episodes.list("pepper")[0].consolidated).toBe(true);
    expect(n.episodes.through("pepper", "s1")).toBe("2026-03-01T11:00:00Z");
    expect(n.data.rolled("pepper")).toBe("2026-03-01");
    await n.stop();
  });

  it("copies again only what isn't here, keeps a newer note, and a dry run leaves the Worker's", async () => {
    const n = await setup();
    const w = worker(tables(), []);
    await moveMemory(target(n), w.fetch, { dryRun: true, log: () => {} });
    expect(w.state).toEqual({ move: null, purged: false });
    await n.data.putNote("pepper", "goals", { kind: "goal", title: "Goals", body: "ship it" }, 1);

    await moveMemory(target(n), w.fetch, { log: () => {} });
    expect(n.data.entries("pepper")).toHaveLength(2);
    expect(n.episodes.count("pepper")).toBe(1);
    expect(n.data.note("pepper", "goals")!.body).toBe("ship it");
    expect(w.state.purged).toBe(true);
    await n.stop();
  });

  it("unfreezes the Worker when an episode comes short", async () => {
    const n = await setup();
    const t = tables();
    t.pepper.episode_parts!.pop();
    const w = worker(t, []);
    await expect(moveMemory(target(n), w.fetch, { log: () => {} })).rejects.toThrow("episode ep1 has 1 of its 2 parts");
    expect(w.state).toEqual({ move: null, purged: false });
    await n.stop();
  });
});

describe("the relay's tunnel", () => {
  // The relay's side of a node's socket: what it sends, and what comes back.
  class FakeSocket extends EventTarget {
    readyState = 0;
    sent: string[] = [];
    constructor(readonly url: string) {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(m: string) {
      this.sent.push(m);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
    }
    request(r: TunnelRequest) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(r) }));
    }
  }

  it("answers at the node's own paths, as <relay>/n/<handle>, and its tokens are that origin's", async () => {
    const n = await setup();
    const base = "https://relay.test/n/abcdefghijklmnopqrstuv";
    let sock: FakeSocket | undefined;
    const r = new Relay({ origin: "https://relay.test", token: { token: "cbe_x", expires: Date.now() + 3600_000 }, socket: (url) => (sock = new FakeSocket(url)) as unknown as WebSocket });
    const states: boolean[] = [];
    const stop = r.serveTunnel(node({ data: n.data, search: n.search, oauth: n.oauth, episodes: n.episodes, origin: base }), { onState: (up) => states.push(up) });
    await Bun.sleep(5);
    expect(sock!.url).toBe("wss://relay.test/e2ee/nodes/live");
    expect(states).toEqual([true]);
    const answer = async (req: Omit<TunnelRequest, "id">) => {
      const id = b64url(random(8));
      const before = sock!.sent.length;
      sock!.request({ id, ...req });
      for (let i = 0; i < 100 && sock!.sent.length === before; i++) await Bun.sleep(5);
      const a = JSON.parse(sock!.sent[before]) as TunnelResponse;
      expect(a.id).toBe(id);
      return { ...a, json: a.body ? JSON.parse(new TextDecoder().decode(fromB64url(a.body))) : undefined };
    };
    const meta = await answer({ method: "GET", path: "/.well-known/oauth-protected-resource", headers: [] });
    expect(meta.status).toBe(200);
    expect(meta.json.resource).toBe(`${base}/mcp`);
    expect((await answer({ method: "GET", path: "/.well-known/oauth-authorization-server", headers: [] })).json.authorization_endpoint).toBe(`${base}/authorize`);
    // A token for the tunnel's resource works there; another account's handle's doesn't.
    const token = n.oauth.mint("pepper", 1, "assistant");
    const list = await answer({ method: "POST", path: "/mcp", headers: [["content-type", "application/json"], ["authorization", `Bearer ${token}`]], body: b64url(utf8(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))) });
    expect(list.status).toBe(200);
    expect(list.json.result.tools.length).toBeGreaterThan(0);
    expect((await answer({ method: "POST", path: "/mcp", headers: [["content-type", "application/json"]], body: b64url(utf8("{}")) })).status).toBe(401);
    const consent = await n.oauth.request(new URLSearchParams({ response_type: "code", client_id: n.oauth.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "c" }).client_id as string, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: `${base}/mcp` }), base);
    expect(consent.client.name).toBe("c");
    await expect(n.oauth.request(new URLSearchParams({ response_type: "code", client_id: consent.client.id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://relay.test/n/zzzzzzzzzzzzzzzzzzzzzz/mcp" }), base)).rejects.toThrow();
    stop();
    expect(states).toEqual([true, false]);
    n.stop();
  });
});

describe("Neovim's boards, on the node", () => {
  it("answers cards/cloud.lua's operations as the Worker did, and tells of every change", async () => {
    const n = await setup();
    const b = { ...n, url: ORIGIN, addBoard: (key: string) => n.replicas.add(listObjects(n.root, { boards: [key], brains: [] })[0]) };
    const told: [string, BoardEvent][] = [];
    const stop = boardEvents(n)((key, e) => told.push([key, e]));
    const place = { root: "/home/me/new", environment: "laptop", commit: "c0ffee", remotes: ["git@example.com:me/new.git"] };

    // A board that isn't there isn't made by opening it; one is by make.
    expect(await boards(b, "subscribe", ["new", "new", place, false])).toBeNull();
    expect(await boards(b, "subscribe", ["new", "new", place, true])).toEqual([]);
    expect(await boards(b, "boards", [])).toContainEqual({ key: "new", name: "new", root: "/home/me/new", commit: "c0ffee", remotes: ["git@example.com:me/new.git"], environments: ["laptop"] });
    expect(await boards(b, "resolve", ["elsewhere", "c0ffee"])).toBe("new");
    expect(await boards(b, "resolve", ["elsewhere", "beef"])).toBeNull();
    // Opened on another environment: that one's root kept too, the name as it was.
    await boards(b, "subscribe", ["new", "ignored", { root: "/srv/new", environment: "vm" }, false]);
    expect(n.data.board("new")).toMatchObject({ name: "new", root: "/srv/new", roots: { laptop: "/home/me/new", vm: "/srv/new" } });

    const card = (await boards(b, "create", ["proj", { title: "First", status: "ready" }])) as { id: string; version: number };
    expect(card.id).toMatch(/^TASK-[0-9A-Z]{4}$/);
    const { card: after } = (await boards(b, "update", ["proj", card.id, 0, { status: "doing" }])) as { card: { status: string; version: number; log?: unknown } };
    expect(after.status).toBe("doing");
    expect(after.version).toBeGreaterThan(card.version);
    expect(after.log).toBeUndefined();
    expect(await boards(b, "log", ["proj", card.id, "me", "started"])).toMatchObject({ seq: 1, who: "me", note: "started" });
    // Another device's change comes as an event too.
    await n.replicas.settled();
    await n.laptop.pull();
    await n.laptop.change({ t: "card", card: card.id, set: { priority: "high" } });
    await n.laptop.push();
    await n.replicas.syncAll();
    expect(((await boards(b, "snapshot", ["proj"])) as { priority: string }[])[0].priority).toBe("high");
    await boards(b, "archive", ["proj", card.id]);
    const other = (await boards(b, "create", ["proj", { title: "Second" }])) as { id: string };
    await boards(b, "delete", ["proj", other.id]);
    expect(n.data.cards("proj", true).map((c) => c.id)).toEqual([card.id]);
    expect(await boards(b, "touch", ["proj", card.id, "claude"])).toBeNull();
    await expect(boards(b, "create", ["nowhere", { title: "x" }])).rejects.toThrow("no board nowhere");

    const proj = told.filter(([k]) => k === "proj").map(([, e]) => (e.type === "card" ? `card ${e.card.status}${e.card.priority ? ` ${e.card.priority}` : ""}` : e.type === "log" ? `log ${e.entry.note}` : e.type === "removed" ? `removed ${e.id === card.id ? "first" : "second"}` : e.type));
    expect(proj).toEqual(["card ready", "card doing", "log started", "card doing high", "removed first", "card backlog", "removed second"]);
    // An archived card that comes back, with its log, comes as the whole board.
    await n.data.archive("proj", card.id, false);
    expect(told.at(-1)).toEqual(["proj", { type: "snapshot", cards: n.data.cards("proj") }]);
    stop();
    await n.data.updateCard("proj", card.id, { title: "Unheard" });
    expect(told.at(-1)![1].type).toBe("snapshot");
    await n.stop();
  });
});

describe("card grants and leases, on the node", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let b: Awaited<ReturnType<typeof setup>> & { url: string; addBoard: () => Promise<void> };
  const card = (title: string, set: Record<string, unknown> = {}) => n.data.createCard("proj", { title, status: "ready", ...set });
  const as = (token: string) => async (name: string, args: Record<string, unknown> = {}) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, token)));
  beforeAll(async () => {
    n = await setup();
    b = { ...n, url: ORIGIN, addBoard: async () => {} };
  });
  afterAll(() => n.stop());

  it("gives a card's agent its own card to change and the board to read, at /mcp alone, until it's revoked", async () => {
    const mine = await card("Mine");
    const other = await card("Someone else's");
    await expect(boards(b, "token", ["proj", "TASK-NONE", "claude"])).rejects.toThrow("no card TASK-NONE");
    const grant = (await boards(b, "token", ["proj", mine.id.toLowerCase(), "claude"])) as { token: string; url: string; expires_at: string };
    expect(grant.url).toBe(`${ORIGIN}/mcp`);
    expect(Date.parse(grant.expires_at) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    const tool = as(grant.token);

    const listed = ((await (await n.call("/mcp", rpc("tools/list", {}, grant.token))).json()) as any).result.tools as { name: string; inputSchema: { properties: object } }[];
    const names = listed.map((t) => t.name);
    expect(names).toContain("claim_card");
    expect(names).toContain("create_card");
    for (const no of ["list_boards", "archive_card", "memory_recall", "note_write"]) expect(names).not.toContain(no);
    expect(listed.every((t) => !("board" in t.inputSchema.properties))).toBe(true);

    // The next card is its own, though another is in ready too.
    expect(JSON.parse((await tool("next_card")).text).id).toBe(mine.id);
    expect(JSON.parse((await tool("read_card", { id: other.id })).text).title).toBe("Someone else's");
    expect((await tool("log", { id: other.id, note: "x" })).text).toContain(`this session works on ${mine.id}`);
    expect((await tool("create_card", { title: "Elsewhere", parent: other.id })).text).toContain("only make follow-ups of your own card");
    expect((await tool("create_card", { title: "Ask", attention: "?" })).text).toContain("request_user_action");
    expect((await tool("archive_card", { id: mine.id, note: "x" })).text).toBe("unknown tool archive_card");
    expect((await tool("memory_recall", { query: "x" })).text).toBe("unknown tool memory_recall");
    // A board named is not the one it works on.
    await tool("log", { board: "elsewhere", id: mine.id, note: "half way" });
    await tool("handoff", { text: "the rest" });
    expect(n.data.card("proj", mine.id).log.map((e) => [e.who, e.note])).toEqual([
      ["claude", "claimed"],
      ["claude", "half way"],
      ["claude", "handoff:\nthe rest"],
    ]);
    // Not the phone's API, the app's or memory.
    for (const p of ["/api/node/boards", "/memory/context"]) expect((await n.call(p, { headers: { Authorization: `Bearer ${grant.token}` } })).status).toBe(401);

    expect(await boards(b, "revoke", ["proj", grant.token])).toBeNull();
    expect((await n.call("/mcp", rpc("tools/list", {}, grant.token))).status).toBe(401);
    expect(n.oauth.grants().some((g) => g.card === mine.id)).toBe(false);
  });

  it("gives a fleet session its board to read and cards to make", async () => {
    const { token } = n.oauth.mintBound({ scope: "session", board: "proj", spawn: "s1", agent: "fleet" });
    const listed = ((await (await n.call("/mcp", rpc("tools/list", {}, token))).json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(listed.sort()).toEqual(["create_card", "handoff", "list_cards", "read_card"]);
    const tool = as(token);
    expect((await tool("claim_card", { id: "TASK-1" })).text).toBe("unknown tool claim_card");
    expect(JSON.parse((await tool("create_card", { title: "Found work" })).text).title).toBe("Found work");
    expect((await tool("handoff", { text: "x" })).text).toContain("Handed off");
  });

  it("keeps a working card's claim while its agent is heard from, and blocks it when it isn't", async () => {
    const c = await card("Long one");
    const quiet = await card("Never heard");
    const { token } = n.oauth.mintBound({ scope: "card", board: "proj", card: c.id, agent: "claude" });
    await as(token)("claim_card", { id: c.id });
    await n.data.updateCard("proj", quiet.id, { agent: "other", agent_state: "working", status: "doing" });
    // The claim made, its lease is written; a word within a minute isn't.
    const first = n.data.lease("proj", c.id)!;
    expect(first).toMatchObject({ agent: "claude", lapsed: false });
    await touch(n.data, "proj", c.id, "claude", first.until - LEASE_MS + 30_000);
    expect(n.data.lease("proj", c.id)!.until).toBe(first.until);
    expect(await touch(n.data, "proj", c.id, "someone")).toBeNull();

    expect(await sweep(n.data, first.until - 1000)).not.toContain(`proj:${c.id}`);
    // Fifteen minutes on: blocked, and the card never heard of is left alone.
    const swept = await sweep(n.data, first.until + 1000);
    expect(swept).toContain(`proj:${c.id}`);
    expect(swept).not.toContain(`proj:${quiet.id}`);
    const blocked = n.data.card("proj", c.id);
    expect(blocked).toMatchObject({ agent_state: "blocked", attention: "claude stopped responding; queue it again or release it" });
    expect(blocked.log.at(-1)!.note).toContain("nothing from claude for 15 minutes");
    expect(n.data.card("proj", quiet.id).agent_state).toBe("working");
    // The agent speaks again (any call, a read too): working again.
    await as(token)("read_card", { id: c.id });
    expect(n.data.card("proj", c.id)).toMatchObject({ agent_state: "working", attention: null });
    expect(n.data.card("proj", c.id).log.at(-1)!.note).toBe("claude is responding again, so it's back to working");
    // A card the user blocked isn't the agent's to undo.
    await n.data.updateCard("proj", c.id, { agent_state: "blocked" });
    expect(await touch(n.data, "proj", c.id, "claude")).toBeNull();
    // Nor is one the budget guard stopped swept.
    await n.data.updateCard("proj", c.id, { agent_state: "working", extra: { budget_hold: "spent" } });
    expect(await sweep(n.data, Date.now() + 2 * LEASE_MS)).toEqual([]);
    // The heartbeat, through the app's touch.
    await n.data.updateCard("proj", c.id, { extra: {} });
    expect(((await boards(b, "touch", ["proj", c.id.toLowerCase(), "claude"])) as { until: number }).until).toBeGreaterThan(Date.now());
  });
});

describe("the bridge's notes and goals, on the node", () => {
  it("keeps the usage reports and reads the goals out of the goal notes", async () => {
    const n = await setup();
    expect(await notes(n, "note_get", ["usage-proj-laptop"])).toBeNull();
    await notes(n, "note_put", ["usage-proj-laptop", { kind: "review", title: "Usage: proj", body: "Project: proj" }]);
    await notes(n, "note_put", ["usage-proj-laptop", { kind: "review", title: "Usage: proj", body: "Project: proj (board proj)" }]);
    expect(await notes(n, "note_get", ["usage-proj-laptop"])).toMatchObject({ kind: "review", body: "Project: proj (board proj)", version: 2 });
    await expect(notes(n, "note_put", ["Bad Id", { kind: "review", title: "x", body: "" }])).rejects.toThrow();
    await n.data.putNote("assistant", "goal-fitness", { kind: "goal", title: "Goal: Fitness, get stronger", body: "## Why\nTo feel good.\n\n## This week (week of 2026-11-02)\n- Train 3 times\n" });
    expect(await notes(n, "goals", [])).toMatchObject([{ id: "goal-fitness", name: "Fitness", aim: "get stronger", why: "To feel good.", week: ["Train 3 times"], week_of: "2026-11-02" }]);
    n.stop();
  });
});

describe("cards' files, on the node", () => {
  it("takes a file inline or by upload, sealed in pieces, and gives it back to the page and another device", async () => {
    const n = await setup();
    const b = { ...n, url: ORIGIN, addBoard: async () => {} };
    const card = await n.data.createCard("proj", { title: "Plot it", status: "ready" });
    const { token } = n.oauth.mintBound({ scope: "card", board: "proj", card: card.id, agent: "claude" });
    const tool = async (args: Record<string, unknown>) => toolText(await n.call("/mcp", rpc("tools/call", { name: "attach_file", arguments: { id: card.id, ...args } }, token)));
    const owner = n.oauth.mint("phone", 1, "owner");
    const get = (mid: string, on = card.id) => n.call(`/api/node/boards/proj/cards/${on}/media/${mid}`, { headers: { Authorization: `Bearer ${owner}` } });

    // Inline: on the card at once, with a line in its log, and a newer card.
    const small = await tool({ name: "dir/plot.png", data: Buffer.from("PNG!").toString("base64") });
    const item = JSON.parse(small.text);
    expect(item).toMatchObject({ name: "plot.png", type: "image/png", size: 4, who: "claude" });
    const after = n.data.card("proj", card.id);
    expect(after.extra.media).toEqual([item]);
    expect(after.version).toBeGreaterThan(card.version);
    expect(after.log.at(-1)!.note).toBe("attached plot.png (image/png, 4 B)");
    const res = await get(item.id);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("PNG!");
    expect((await get("000000000000")).status).toBe(404);
    expect((await tool({ name: "x.png", data: "not base64!" })).text).toBe("data must be base64");
    expect((await toolText(await n.call("/mcp", rpc("tools/call", { name: "attach_file", arguments: { id: "TASK-ELSE", name: "x.png" } }, token)))).text).toContain(`this session works on ${card.id}`);

    // An upload: three pieces for 40 MB, none of it in the clear on the relay.
    const offer = JSON.parse((await tool({ name: "run.mp4" })).text) as { upload: string; command: string };
    expect(offer.upload).toMatch(new RegExp(`^${ORIGIN}/upload/[0-9a-f]{48}$`));
    expect(offer.command).toBe(`curl -fsS -T <path to run.mp4> ${offer.upload}`);
    const big = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
    big.set(new TextEncoder().encode("PLAINTEXT-MARKER"), PIECE + 5);
    const path = new URL(offer.upload).pathname;
    expect((await n.call(path, { method: "PUT" })).status).toBe(411);
    const had = n.blobs.kept.size;
    const put = await n.call(path, { method: "PUT", body: big, headers: { "Content-Length": String(big.length) } });
    expect(put.status).toBe(201);
    const video = (await put.json()) as { id: string; size: number; type: string };
    expect(video).toMatchObject({ size: big.length, type: "video/mp4" });
    expect(n.blobs.kept.size - had).toBe(3);
    for (const s of n.data.media("proj", card.id).find((m) => m.id === video.id)!.blobs) expect(Buffer.from(n.blobs.kept.get(s)!).includes("PLAINTEXT-MARKER")).toBe(false);
    // Good once.
    expect((await n.call(path, { method: "PUT", body: "x", headers: { "Content-Length": "1" } })).status).toBe(404);
    const back = new Uint8Array(await (await get(video.id)).arrayBuffer());
    expect(back.length).toBe(big.length);
    expect(Buffer.from(back).equals(Buffer.from(big))).toBe(true);
    // Another device has none of the pieces here: they come from the relay.
    const other = new Media({ data: n.data, blobs: n.blobs, dir: join(n.dir, "other") });
    expect(Buffer.from(await other.serve("proj", card.id, video.id)!.arrayBuffer()).equals(Buffer.from(big))).toBe(true);
    expect(other.serve("proj", "TASK-ELSE", video.id)).toBeUndefined();
    // Too big is refused before a byte is kept.
    const offer2 = JSON.parse((await tool({ name: "huge.bin" })).text) as { upload: string };
    expect((await n.call(new URL(offer2.upload).pathname, { method: "PUT", body: "x", headers: { "Content-Length": String(101 * 1024 * 1024) } })).status).toBe(413);

    // The card deleted for good: its files and their blobs too.
    expect(await boards(b, "delete", ["proj", card.id])).toBeNull();
    expect(n.data.media("proj", card.id)).toEqual([]);
    expect(n.blobs.kept.size).toBe(had - 1);
    n.stop();
  });
});
