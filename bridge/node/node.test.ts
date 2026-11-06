import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKeys, newRoot, random } from "../../lib/e2ee/keys";
import { entries, indexId, indexKey, remember } from "../../lib/e2ee/sharing";
import { EpochChanged, type LogTransport, type ReplicaStore, Replica, memoryStore, offline } from "../../lib/e2ee/sync";
import { type NewOp, type Snapshot, type TunnelRequest, type TunnelResponse, type WireOp, b64url, fromB64url, utf8 } from "../../lib/e2ee/wire";
import { Relay } from "../../lib/e2ee/relay";
import { type Identity, initiate, pipe, respond } from "../../lib/e2ee/channel";
import { certify, checkCert, newDevice } from "../../lib/e2ee/device";
import { DAY, dayObject, listObjects, noteRecord } from "./objects";
import { Conflict } from "./day";
import { Replicas } from "./replicas";
import { Data, Invalid, now } from "./data";
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
import { Hub, joinHub } from "../hub";
import { type Hosted, type TerminalOut, serve } from "../sessions";
import { type PeerEvent, type Reach, Peers } from "../peers";
import type { Fleet } from "./mcp";
import { moveBoards, moveMemory, movePlans } from "./move";
import { type DayEvent, boardEvents, boards, dayEvents, notes, plans } from "./app";
import { LEASE_MS, sweep, touch } from "./leases";
import { lentCalendar, startCalendar, writeAccepted } from "./calendar";
import { type Block, type ChatMessage, type Plan, today } from "../../lib/model/plans";
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

async function setup(o: { fleet?: Fleet } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-node-"));
  dirs.push(dir);
  const root = newRoot();
  const shared = relay();
  const objects = [...listObjects(root, { boards: ["proj"], brains: ["assistant"] }), dayObject(root)];
  const replicas = await Replicas.open({ objects, transport: as(shared, "node"), device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const search = new Search(data);
  const oauth = new OAuthStore(join(dir, "oauth.json"));
  const episodes = new Episodes();
  const blobs = memoryBlobs();
  const media = new Media({ data, blobs, dir: join(dir, "blobs") });
  const app = node({ data, search, oauth, episodes, media, origin: ORIGIN, fleet: () => o.fleet });
  // Another device of the account: the laptop, on the same relay.
  const board = objects.find((o) => o.kind === "board")!;
  const laptop = await Replica.open({ transport: as(shared, "laptop"), key: board.key, object: board.object, device: "laptop" });
  const call = (path: string, init: RequestInit = {}) => app(new Request(`${ORIGIN}${path}`, init));
  return { dir, root, shared, replicas, data, search, oauth, episodes, media, blobs, app, call, laptop, stop: () => replicas.stop() };
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

  it("makes a board for the portal's Add project, the owner's alone", async () => {
    const m = await setup();
    const app = node({ data: m.data, search: m.search, oauth: m.oauth, origin: ORIGIN, addBoard: (key) => m.replicas.add(listObjects(m.root, { boards: [key], brains: [] })[0]) });
    const mine = `Bearer ${m.oauth.mint("portal", 1)}`;
    const call = async (method: string, key: string, body?: unknown, token = mine, to = app) => {
      const res = await to(new Request(`${ORIGIN}/api/node/boards${key}`, { method, headers: { "Content-Type": "application/json", Authorization: token }, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: res.status, body: (await res.json()) as any };
    };
    const remote = "git@github.com:me/thing.git";
    const other = "https://example.com/me/thing.git";
    expect(await call("PUT", "/github-me-thing", { name: "thing", remotes: [remote] })).toEqual({ status: 201, body: { key: "github-me-thing", name: "thing", remotes: [remote] } });
    expect(await call("PUT", "/github-me-thing", { remotes: [remote, other] })).toEqual({ status: 200, body: { key: "github-me-thing", name: "thing", remotes: [remote, other] } });
    expect((await call("PUT", "/github-me-thing", { remotes: ["/home/me/thing"] })).status).toBe(400);
    expect((await call("PUT", "/bad%20key", { name: "x" })).status).toBe(400);
    expect((await call("PUT", "/other", { name: "x" }, `Bearer ${m.oauth.mint("claude.ai", 1, "assistant")}`)).status).toBe(403);
    expect((await call("GET", "")).body.find((b: { key: string }) => b.key === "github-me-thing")).toMatchObject({ name: "thing", remotes: [remote, other], cards: [] });
    // Without a way to keep a board, none is made.
    expect((await call("PUT", "/elsewhere", { name: "x" }, mine, m.app)).status).toBe(501);
    await m.stop();
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
    expect(status.objects.map((o: { kind: string; name: string }) => `${o.kind}/${o.name}`)).toEqual(["board/proj", "brain/assistant", "day/day"]);
    expect(status.calendar).toBe(false);
  });

  it("is the same on a sealed channel, the phone's token and all, or the device's own, but never loopback", async () => {
    const keys = accountKeys(newRoot());
    const id = (name: string): Identity => {
      const d = newDevice();
      return { device: d, cert: certify(keys, d, name), trust: (c) => checkCert(keys.id, c, []) };
    };
    const phone = id("fleetd");
    phone.cert = certify(keys, phone.device, "fleetd", Date.now(), "relay");
    const here = id("node");
    let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
    a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
    b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
    // serve.ts's: the tunnel's handler, at its origin.
    const [ch] = await Promise.all([initiate(a.link, phone, here.device.id), respond(b.link, here, { serve: (req, c) => n.app(req, undefined, c.peer) })]);
    expect((await ch.fetch("/api/node/boards", { headers: { Authorization: "Bearer cbn_nonsense" } })).status).toBe(401);
    // No token: the relay-only device, which is the owner.
    const grant = await ch.fetch("/api/node/grants", { method: "POST", body: JSON.stringify({ scope: "brain", brain: "assistant", agent: "pepper" }) });
    expect(grant.status).toBe(201);
    const res = await ch.fetch("/api/node/boards", { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }[])[0].key).toBe("proj");
    const made = await ch.fetch("/api/node/boards/proj/cards", { method: "POST", headers: auth, body: JSON.stringify({ title: "Sealed" }) });
    expect(made.status).toBe(201);
    expect((await ch.fetch("/app", { method: "POST", headers: auth, body: JSON.stringify({ op: "board_boards", args: [] }) })).status).toBe(404);
    ch.close();
  });

  it("adds a log written elsewhere once, whatever else is sent with it", async () => {
    const e = (key: string, text: string, at = "2030-01-02T17:00:00Z") => ({ day: "2030-01-02", at, who: "vault", text, key });
    await n.data.importEntries("assistant", [{ from: "worker:1", at: "2030-01-02T16:00:00Z", day: "2030-01-02", who: "vault", text: "Moved already." }]);
    expect((await api("POST", "brains/assistant/entries", { entries: [e("a", "First."), e("old", "Moved already.", "2030-01-02T16:00:00Z")] })).body).toEqual({ added: 1 });
    expect((await api("POST", "brains/assistant/entries", { entries: [e("z", "Earlier.", "2030-01-02T15:00:00Z"), e("a", "First.")] })).body).toEqual({ added: 1 });
    expect(n.data.entries("assistant", "2030-01-02").map((x) => x.text)).toEqual(["Earlier.", "Moved already.", "First."]);
    expect((await api("POST", "brains/assistant/entries", { entries: [{ ...e("b", "x"), at: "soon" }] })).status).toBe(400);
  });
});

describe("the calendar, written by the leader", () => {
  it("writes each accepted day ahead once, again when it's edited, and keeps Google's refusal", async () => {
    const n = await setup();
    const calls: { method: string; url: string; body?: any }[] = [];
    let refuse = false;
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined });
      if (url.includes("oauth2")) return refuse ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ access_token: "g" });
      if ((init?.method ?? "GET") === "GET") return Response.json({ items: [{ id: "old" }] });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "e" });
    };
    const c = { client_id: "c", client_secret: "s", refresh: "r", calendar: "cal@group", timezone: "UTC" };
    const day = (d: number) => new Date(Date.parse(`${today("UTC")}T12:00:00Z`) + d * 86400_000).toISOString().slice(0, 10);
    const blocks = [
      { id: "a", start: 540, stop: 600, title: "Deep: the node", kind: "work" as const },
      { id: "b", start: 600, stop: 630, title: "Standup", kind: "fixed" as const },
    ];
    const accept = async (date: string) => {
      const p = await n.data.propose(date, { from: 0, blocks, reasons: [], why: {}, made: now(), by: "pepper" });
      return n.data.accept(date, null, blocks, p.proposal!.id);
    };
    await n.data.propose(day(1), { from: 0, blocks, reasons: [], why: {}, made: now(), by: "pepper" });
    for (const d of [-1, 2, 8]) await accept(day(d));
    expect(await writeAccepted(n.data, c, fake)).toEqual([day(2)]);
    expect(calls.map((x) => x.method)).toEqual(["POST", "GET", "DELETE", "POST", "POST"]);
    expect(calls[3].body.summary).toBe("Deep: the node");
    expect(n.data.plan(day(2)).calendar).toMatchObject({ accepted: n.data.plan(day(2)).accepted, blocks: 1 });

    calls.length = 0;
    expect(await writeAccepted(n.data, c, fake)).toEqual([]);
    await n.data.setDay(day(2), null, [{ ...blocks[0], title: "Deep: calendar" }]);
    expect(await writeAccepted(n.data, c, fake)).toEqual([day(2)]);
    expect(calls.find((x) => x.body?.summary === "Deep: calendar")).toBeTruthy();

    refuse = true;
    await accept(day(1));
    expect(await writeAccepted(n.data, c, fake)).toEqual([day(1)]);
    expect(n.data.plan(day(1)).calendar?.error).toContain("calendar-login");
    expect(await writeAccepted(n.data, c, fake)).toEqual([]);
    n.stop();
  });

  it("writes with the Worker's connection, lent, while its token lasts", async () => {
    let asked = 0;
    let answer: () => Response = () => Response.json({ error: "the calendar isn't connected" }, { status: 404 });
    let signedIn = true;
    const lent = lentCalendar(() => (signedIn ? (asked++, Promise.resolve(answer())) : undefined));
    expect(await lent()).toBeUndefined();
    // None connected is asked again only after a while.
    expect(await lent()).toBeUndefined();
    expect(asked).toBe(1);

    const lent2 = lentCalendar(() => (signedIn ? (asked++, Promise.resolve(answer())) : undefined));
    let expires = new Date(Date.now() + 3600_000).toISOString();
    answer = () => Response.json({ access_token: "ya29.lent", expires_at: expires, calendar: "cal@group", timezone: "UTC" });
    expect(await lent2()).toEqual({ calendar: "cal@group", timezone: "UTC", token: "ya29.lent" });
    expect(await lent2()).toMatchObject({ token: "ya29.lent" });
    expect(asked).toBe(2);

    // The lent token is the one Google sees; no refresh of the node's own.
    const n = await setup();
    const date = today("UTC");
    const p = await n.data.propose(date, { from: 0, blocks: [], reasons: [], why: {}, made: now(), by: "pepper" });
    await n.data.accept(date, null, [], p.proposal!.id);
    const auth: string[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) throw new Error("refreshed");
      auth.push(String((init?.headers as Record<string, string>).Authorization));
      return Response.json({ items: [] });
    };
    expect(await writeAccepted(n.data, (await lent2())!, fake)).toEqual([date]);
    expect(new Set(auth)).toEqual(new Set(["Bearer ya29.lent"]));

    // Within a minute of ending, it's asked for again; Google's refusal there is the Worker's message.
    expires = new Date(Date.now() + 30_000).toISOString();
    const lent3 = lentCalendar(() => (signedIn ? (asked++, Promise.resolve(answer())) : undefined));
    await lent3();
    answer = () => Response.json({ error: "Google no longer takes the calendar's sign-in; connect it again at https://x/calendar/connect" }, { status: 502 });
    await expect(lent3()).rejects.toThrow("connect it again");
    signedIn = false;
    expect(await lent3()).toBeUndefined();
    n.stop();
  });

  it("writes only while the node leads and has a calendar", async () => {
    const n = await setup();
    let lead = false;
    let config: Parameters<typeof writeAccepted>[1] | undefined;
    let posts = 0;
    const fake = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && !url.includes("oauth2")) posts++;
      return url.includes("oauth2") ? Response.json({ access_token: "g" }) : Response.json({ items: [] });
    };
    const stop = startCalendar({ data: n.data, replicas: n.replicas, leads: async () => lead, config: () => config, fetch: fake });
    const date = today("UTC");
    const p = await n.data.propose(date, { from: 0, blocks: [], reasons: [], why: {}, made: now(), by: "pepper" });
    await n.data.accept(date, null, [], p.proposal!.id);
    await Bun.sleep(20);
    config = { client_id: "c", client_secret: "s", refresh: "r", calendar: "cal", timezone: "UTC" };
    await n.data.say(date, "me", "nudge");
    await Bun.sleep(20);
    expect(n.data.plan(date).calendar).toBeUndefined();
    lead = true;
    await n.data.say(date, "me", "nudge");
    for (let i = 0; i < 50 && !n.data.plan(date).calendar; i++) await Bun.sleep(10);
    expect(n.data.plan(date).calendar).toMatchObject({ blocks: 0 });
    expect(posts).toBe(1);
    stop();
    n.stop();
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

  it("give a session its corkboard server's board tools apart from its memory's", async () => {
    const token = n.oauth.mint("session", 30, "assistant", "assistant");
    const names = async (tools: string) => ((await (await n.call(`/mcp?tools=${tools}`, rpc("tools/list", {}, token))).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    const board = await names("board");
    expect(board).toContain("handoff");
    expect(board).toContain("list_cards");
    expect(board).not.toContain("memory_recall");
    expect(await names("memory")).not.toContain("handoff");
    expect((await toolText(await n.call("/mcp?tools=board", rpc("tools/call", { name: "handoff", arguments: { text: "next" } }, token)))).text).toContain("Handed off");
    expect((await toolText(await n.call("/mcp?tools=board", rpc("tools/call", { name: "memory_recall", arguments: { query: "x" } }, token)))).text).toContain("unknown tool");
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

  it("hands fleetd a slot's grant, owner only, for the /mcp it asked at", async () => {
    const c = await card("For a slot");
    const ask = (token: string, method: string, body: unknown) =>
      n.call("/api/node/grants", { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const owner = n.oauth.mint("fleetd", 1);
    expect((await ask(n.oauth.mint("pepper", 1, "assistant", "pepper"), "POST", { scope: "card", board: "proj", card: c.id, agent: "fleet" })).status).toBe(403);
    expect((await ask(owner, "POST", { scope: "card", board: "nope", card: c.id, agent: "fleet" })).status).toBe(404);
    expect((await ask(owner, "POST", { scope: "card", board: "proj", card: "TASK-NONE", agent: "fleet" })).status).toBe(404);
    expect((await ask(owner, "POST", { scope: "owner", board: "proj", agent: "fleet" })).status).toBe(400);
    const res = await ask(owner, "POST", { scope: "card", board: "proj", card: c.id.toLowerCase(), agent: "fleet" });
    expect(res.status).toBe(201);
    const g = (await res.json()) as { token: string; url: string };
    expect(g.url).toBe(`${ORIGIN}/mcp`);
    expect(JSON.parse((await as(g.token)("claim_card", { id: c.id })).text).id).toBe(c.id);
    // Not a grant to hand out more.
    expect((await ask(g.token, "POST", { scope: "session", board: "proj", spawn: "s2", agent: "x" })).status).toBe(401);
    const s = (await (await ask(owner, "POST", { scope: "session", board: "proj", spawn: "s2", agent: "fleet" })).json()) as { token: string };
    expect(n.oauth.grants().find((x) => x.spawn === "s2")?.scope).toBe("session");
    // A brain's, for a slot's memory hooks, and the board's settings, for its repo.
    const brain = (await (await ask(owner, "POST", { scope: "brain", brain: "assistant", agent: "coding-1" })).json()) as { token: string; url: string };
    expect(brain.url).toBe(ORIGIN);
    expect((await n.call("/memory/context", { headers: { Authorization: `Bearer ${brain.token}` } })).status).toBe(200);
    expect((await ask(owner, "POST", { scope: "brain", brain: "nope", agent: "x" })).status).toBe(404);
    await n.data.putBoard("proj", { roots: { local: "/srv/proj" } });
    expect(((await (await n.call("/api/node/boards/proj", { headers: { Authorization: `Bearer ${owner}` } })).json()) as any).roots).toEqual({ local: "/srv/proj" });
    for (const t of [g.token, s.token, brain.token]) expect(await (await ask(owner, "DELETE", { token: t })).json()).toEqual({ revoked: true });
    expect((await n.call("/mcp", rpc("tools/list", {}, g.token))).status).toBe(401);
    expect(n.oauth.grants().some((x) => x.brain === "assistant" && x.name.startsWith("coding-1"))).toBe(false);
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

describe("the fleet's spawns, from the node", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  const asked: { method: string; path: string; body?: any }[] = [];
  const fleet: Fleet = async (method, path, body?: any) => {
    asked.push({ method, path, body });
    if (path === "/spawns") return { id: "sp1", template: "coding", environment: "droplet", agent: "fleet-sp1", state: "queued" };
    return { path };
  };
  const as = (token: string) => async (name: string, args: Record<string, unknown> = {}) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, token)));
  const names = async (token: string) => ((await (await n.call("/mcp", rpc("tools/list", {}, token))).json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  beforeAll(async () => void (n = await setup({ fleet })));
  afterAll(() => n.stop());

  it("queues a spawn on the node's card with node: true, and marks and logs the card", async () => {
    const c = await n.data.createCard("proj", { title: "Fix it", status: "ready" });
    const tool = as(n.oauth.mint("phone", 1));
    expect(JSON.parse((await tool("spawn_agent", { task: "fix it", board: "proj", card: c.id.toLowerCase() })).text).id).toBe("sp1");
    expect(asked.at(-1)).toEqual({ method: "POST", path: "/spawns", body: { task: "fix it", board: "proj", card: c.id, node: true } });
    expect(n.data.card("proj", c.id)).toMatchObject({ agent: "fleet-sp1", agent_state: "queued" });
    expect(n.data.card("proj", c.id).log.at(-1)).toMatchObject({ who: "fleet", note: "spawned sp1: coding in droplet, asked by assistant" });
    // Once it has an agent at work, not again.
    const again = await tool("spawn_agent", { task: "again", board: "proj", card: c.id });
    expect(again.error).toBe(true);
    expect(again.text).toContain("queued with fleet-sp1");
    expect(asked).toHaveLength(1);
  });

  it("leaves another board's spawn, and status and stop, to the Worker", async () => {
    const tool = as(n.oauth.mint("claude.ai", 1, "assistant"));
    await tool("spawn_agent", { task: "x", board: "elsewhere", card: "TASK-2" });
    expect(asked.at(-1)!.body).toEqual({ task: "x", board: "elsewhere", card: "TASK-2" });
    await tool("start_session", { board: "elsewhere", message: "hi" });
    expect(asked.at(-1)!.body).toEqual({ board: "elsewhere", task: "hi", interactive: true });
    expect(JSON.parse((await tool("spawn_status", { id: "sp 1" })).text).path).toBe("/fleet/status?id=sp%201");
    await tool("spawn_stop", { id: "sp1" });
    expect(asked.at(-1)).toEqual({ method: "POST", path: "/spawns/sp1/stop", body: undefined });
  });

  it("shows the spawn tools to the user's own clients alone", async () => {
    expect(await names(n.oauth.mint("phone", 1))).toContain("spawn_agent");
    expect(await names(n.oauth.mint("claude.ai", 1, "assistant"))).toContain("spawn_status");
    const c = await n.data.createCard("proj", { title: "Held", status: "ready" });
    for (const t of [
      n.oauth.mint("pepper", 1, "assistant", "assistant"),
      n.oauth.mintBound({ scope: "card", board: "proj", card: c.id, agent: "claude" }).token,
      n.oauth.mintBound({ scope: "session", board: "proj", spawn: "s1", agent: "fleet" }).token,
    ]) {
      expect(await names(t)).not.toContain("spawn_agent");
      expect((await as(t)("spawn_agent", { task: "x" })).text).toBe("unknown tool spawn_agent");
    }
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

describe("boards moved off the Worker", () => {
  // The Worker's board move routes (api.ts), over cards and files kept here, paged a card at a time.
  type Card = { id: string; n: number; log: { at: string; who: string; note: string }[]; [k: string]: unknown };
  function worker(boards: { key: string; name: string; root: string | null; roots: Record<string, string>; cards: Card[] }[], files: Record<string, string>) {
    const calls: string[] = [];
    const state = { move: null as null | { account: string; state: string }, done: false };
    const fetch = async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${path.split("?")[0]}`);
      const url = new URL(path, "https://worker.test");
      if (url.pathname === "/api/boards/move" && method === "POST") {
        state.move = { account: JSON.parse(String(init.body)).account, state: "moving" };
        return Response.json({ ...state.move, at: "2026-11-05T00:00:00Z", handle: "h", node: "n", boards: boards.map(({ cards: _, ...b }) => b) });
      }
      if (url.pathname === "/api/boards/move" && method === "DELETE") return (state.move = null), new Response(null, { status: 204 });
      if (state.move?.state !== "moving") return new Response("not moving", { status: 409 });
      if (url.pathname === "/api/boards/move/done") return (state.done = true), (state.move.state = "moved"), Response.json(state.move);
      const [key, media, , mid] = url.pathname.slice("/api/boards/move/".length).split("/").map(decodeURIComponent);
      if (media === "media") return files[mid] === undefined ? new Response("no such file", { status: 404 }) : new Response(files[mid]);
      const after = Number(url.searchParams.get("after"));
      const all = boards.find((b) => b.key === key)!.cards.filter((c) => c.n > after);
      return Response.json({ cards: all.slice(0, 1), next: all.length > 1 ? all[0].n : null });
    };
    return { fetch, calls, state };
  }
  const file = { id: "0123456789ab", name: "plot.png", type: "image/png", size: 4, at: "2026-03-01T12:00:00Z", who: "claude" };
  const boardsOf = (): Parameters<typeof worker>[0] => [
    {
      key: "proj",
      name: "Project",
      root: "/src/proj",
      roots: { droplet: "/home/workspace/src/proj" },
      cards: [
        { id: "TASK-1", n: 1, title: "Plot it", status: "done", archived: null, created: "2026-03-01T10:00:00Z", updated: "2026-03-01T12:00:00Z", extra: { media: [file], pr: 7 }, log: [{ at: "2026-03-01T11:00:00Z", who: "claude", note: "plotting" }, { at: "2026-03-01T12:00:00Z", who: "claude", note: "attached plot.png (image/png, 4 B)" }] },
        { id: "TASK-2", n: 2, title: "Old", status: "done", archived: "2026-02-02T00:00:00Z", created: "2026-02-01T10:00:00Z", updated: "2026-02-01T10:00:00Z", log: [] },
      ],
    },
    { key: "fresh", name: "Fresh", root: null, roots: {}, cards: [{ id: "TASK-1", n: 1, title: "First", status: "ready", archived: null, created: "2026-03-02T10:00:00Z", updated: "2026-03-02T10:00:00Z", log: [] }] },
  ];
  const target = (n: Awaited<ReturnType<typeof setup>>) => ({
    ...n,
    account: "acct-0123456789abcdefghij",
    addBoard: (key: string) => n.replicas.add(listObjects(n.root, { boards: [key], brains: [] })[0]),
  });

  it("copies every board's cards, logs, files and settings, then deletes the Worker's", async () => {
    const n = await setup();
    const w = worker(boardsOf(), { [file.id]: "PNG!" });
    const moved = await moveBoards(target(n), w.fetch, { log: () => {} });
    expect(moved).toEqual({ proj: { cards: 2, files: 1 }, fresh: { cards: 1, files: 0 } });
    expect(w.state.done).toBe(true);

    expect(n.data.board("proj")).toMatchObject({ name: "Project", root: "/src/proj", roots: { droplet: "/home/workspace/src/proj" } });
    expect(n.data.cards("proj").map((c) => c.id)).toEqual(["TASK-1"]);
    const c = n.data.card("proj", "TASK-1");
    expect(c).toMatchObject({ title: "Plot it", status: "done", created: "2026-03-01T10:00:00Z" });
    expect(c.extra.pr).toBe(7);
    // The file's own record, with the Worker's id and time, and no second log line.
    expect(c.extra.media).toEqual([file]);
    expect(c.log.map((e) => e.note)).toEqual(["plotting", "attached plot.png (image/png, 4 B)"]);
    expect(await n.media.serve("proj", "TASK-1", file.id)!.text()).toBe("PNG!");
    expect(n.data.cards("proj", true).find((c) => c.id === "TASK-2")).toMatchObject({ title: "Old", archived: "2026-02-02T00:00:00Z" });
    expect(n.data.cards("fresh").map((c) => c.title)).toEqual(["First"]);
    await n.stop();
  });

  it("a dry run leaves the Worker's, and a second run adds nothing", async () => {
    const n = await setup();
    const w = worker(boardsOf(), { [file.id]: "PNG!" });
    await moveBoards(target(n), w.fetch, { dryRun: true, log: () => {} });
    expect(w.state).toEqual({ move: null, done: false });
    expect(w.calls.at(-1)).toBe("DELETE /api/boards/move");

    const state = () => JSON.stringify(["proj", "fresh"].map((k) => n.replicas.get("board", k)!.state));
    const had = state();
    const kept = n.blobs.kept.size;
    await moveBoards(target(n), w.fetch, { log: () => {} });
    expect(state()).toBe(had);
    expect(n.blobs.kept.size).toBe(kept);
    expect(n.data.card("proj", "TASK-1").log).toHaveLength(2);
    expect(w.state.done).toBe(true);
    await n.stop();
  });

  it("unfreezes the Worker when a file can't be had", async () => {
    const n = await setup();
    const w = worker(boardsOf(), {});
    await expect(moveBoards(target(n), w.fetch, { log: () => {} })).rejects.toThrow("404");
    expect(w.state).toEqual({ move: null, done: false });
    await n.stop();
  });
});

describe("day plans and chat moved off the Worker", () => {
  // The Worker's plan move routes (api.ts), paged one at a time.
  const block: Block = { id: "a", start: 600, stop: 660, title: "A", kind: "work" };
  const plansOf = (): Plan[] => [
    { date: "2026-10-24", version: 3, projects: [{ key: "jobs", name: "Jobs" }], day: { blocks: [block], ranked: [], later: [], inputs: [] }, proposal: null, asked: [], accepted: "2026-10-24T08:00:00Z", calendar: { accepted: "2026-10-24T08:00:00Z", at: "2026-10-24T08:00:01Z", blocks: 1 } },
    { date: "2026-10-25", version: 2, projects: [], day: { blocks: [], ranked: [], later: [], inputs: [] }, proposal: { from: 0, blocks: [block], reasons: [], why: {}, by: "assistant", answering: [] } as never, asked: ["later please", "and shorter"], accepted: null },
  ];
  const messagesOf = (): ChatMessage[] => [
    { id: 1, at: "2026-10-24T09:00:00.000Z", who: "Me", text: "hi", by_user: true, delivered: "2026-10-24T09:00:05Z" },
    { id: 2, at: "2026-10-24T09:00:00.000Z", who: "pepper", text: "hello", by_user: false, delivered: null },
    { id: 10, at: "2026-10-24T09:01:00.000Z", who: "Me", text: "not yet seen", by_user: true, delivered: null },
  ];
  function worker(plans: Plan[], messages: ChatMessage[]) {
    const calls: string[] = [];
    const state = { move: null as null | { account: string; state: string }, done: false };
    const fetch = async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${path.split("?")[0]}`);
      const url = new URL(path, "https://worker.test");
      if (url.pathname === "/api/plans/move" && method === "POST") {
        state.move = { account: JSON.parse(String(init.body)).account, state: "moving" };
        return Response.json({ ...state.move, at: "2026-11-05T00:00:00Z", calendar: { connected: true, id: "claude@group.calendar.google.com", timezone: "UTC" } });
      }
      if (url.pathname === "/api/plans/move" && method === "DELETE") return (state.move = null), new Response(null, { status: 204 });
      if (state.move?.state !== "moving") return new Response("not moving", { status: 409 });
      if (url.pathname === "/api/plans/move/done") return (state.done = true), (state.move.state = "moved"), Response.json(state.move);
      const after = url.searchParams.get("after") ?? "";
      if (url.pathname === "/api/plans/move/plans") {
        const all = plans.filter((p) => p.date > after);
        return Response.json({ plans: all.slice(0, 1), next: all.length > 1 ? all[0].date : null });
      }
      const all = messages.filter((m) => m.id > Number(after));
      return Response.json({ messages: all.slice(0, 1), next: all.length > 1 ? all[0].id : null });
    };
    return { fetch, calls, state };
  }
  const target = (n: Awaited<ReturnType<typeof setup>>) => ({ ...n, account: "acct-0123456789abcdefghij", calendar: () => undefined });

  it("copies every plan and message, as they were, then deletes the Worker's", async () => {
    const n = await setup();
    const w = worker(plansOf(), messagesOf());
    const moved = await movePlans(target(n), w.fetch, { log: () => {} });
    expect(moved).toEqual({ plans: 2, messages: 3, calendar: { connected: true, id: "claude@group.calendar.google.com", timezone: "UTC" } });
    expect(w.state.done).toBe(true);

    // An accepted day, already on the calendar: not written again.
    expect(n.data.plan("2026-10-24")).toMatchObject({ day: { blocks: [block] }, proposal: null, accepted: "2026-10-24T08:00:00Z", projects: [{ key: "jobs" }], calendar: { blocks: 1 } });
    // A proposal waiting, and what's been asked since, still open to accept.
    const waiting = n.data.plan("2026-10-25");
    expect(waiting).toMatchObject({ proposal: { id: "worker-2", blocks: [block] }, asked: ["later please", "and shorter"] });
    expect((await n.data.accept("2026-10-25", null, [block], "worker-2")).day.blocks).toEqual([block]);

    // In order, with their times and who passed them on; ids the node's strings.
    const chat = n.data.chat();
    expect(chat.map((m) => [m.text, m.at, m.delivered])).toEqual([
      ["hi", "2026-10-24T09:00:00.000Z", "2026-10-24T09:00:05Z"],
      ["hello", "2026-10-24T09:00:00.000Z", null],
      ["not yet seen", "2026-10-24T09:01:00.000Z", null],
    ]);
    // What pepperd hadn't passed on is still the user's to change, and newer messages go after.
    expect((await n.data.edit(chat[2].id, "changed")).text).toBe("changed");
    expect((await n.data.post("pepper", "after")).id > chat[2].id).toBe(true);
    await n.stop();
  });

  it("a dry run leaves the Worker's, and a second run adds nothing", async () => {
    const n = await setup();
    const w = worker(plansOf(), messagesOf());
    await movePlans(target(n), w.fetch, { dryRun: true, log: () => {} });
    expect(w.state).toEqual({ move: null, done: false });
    expect(w.calls.at(-1)).toBe("DELETE /api/plans/move");

    const state = () => JSON.stringify(n.replicas.get("day", DAY)!.state);
    const had = state();
    await movePlans(target(n), w.fetch, { log: () => {} });
    expect(state()).toBe(had);
    expect(n.data.plan("2026-10-25").asked).toHaveLength(2);
    expect(w.state.done).toBe(true);
    await n.stop();
  });

  it("calls the Worker's move off when a page can't be had", async () => {
    const n = await setup();
    const w = worker(plansOf(), messagesOf());
    const broken = async (path: string, init?: RequestInit) => (path.startsWith("/api/plans/move/chat") ? new Response("boom", { status: 500 }) : w.fetch(path, init));
    await expect(movePlans(target(n), broken, { log: () => {} })).rejects.toThrow("500");
    expect(w.state).toEqual({ move: null, done: false });
    await n.stop();
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

describe("day plans and chat, on the node", () => {
  const block = (id: string, start: number, title = id) => ({ id, start, stop: start + 60, title, kind: "work" as const });
  const proposal = (blocks: ReturnType<typeof block>[]) => ({ from: 0, blocks, reasons: [], why: {}, made: "2026-11-05T08:00:00Z", by: "pepper" });
  // The phone: another device with the day object, on the same relay.
  async function phoneOf(n: Awaited<ReturnType<typeof setup>>) {
    const replicas = await Replicas.open({ objects: [dayObject(n.root)], transport: as(n.shared, "phone"), device: "phone" });
    await replicas.start({ live: false });
    return { data: new Data(replicas, "UTC"), replicas };
  }
  const sync = async (...all: { replicas: Replicas }[]) => {
    for (const x of all) await x.replicas.settled();
    for (const x of all) await x.replicas.syncAll();
  };

  it("keeps a proposal and an accept made at once, what's asked meanwhile, and refuses a stale accept", async () => {
    const n = await setup();
    const phone = await phoneOf(n);
    const date = "2026-11-05";
    expect(n.data.plan(date)).toMatchObject({ version: 0, proposal: null, asked: [], accepted: null });

    await phone.data.say(date, "me", "start later");
    await sync(phone, n);
    const a = await n.data.propose(date, proposal([block("a", 600)]), [{ key: "proj", name: "Project" }]);
    expect(a.asked).toEqual([]);
    expect(a.proposal).toMatchObject({ answering: ["start later"], blocks: [block("a", 600)] });
    expect(a.projects).toEqual([{ key: "proj", name: "Project" }]);
    await sync(n, phone);

    // At once: the phone accepts a, and asks for more; the node proposes b.
    const seen = phone.data.plan(date);
    await phone.data.accept(date, seen.version, [block("a", 660)], seen.proposal!.id);
    await phone.data.say(date, "me", "no gym");
    await n.data.propose(date, proposal([block("b", 700)]));
    await sync(phone, n, phone);
    for (const d of [n.data, phone.data]) {
      const p = d.plan(date);
      expect(p.day.blocks).toEqual([block("a", 660)]);
      expect(p.accepted).not.toBeNull();
      expect(p.proposal?.blocks).toEqual([block("b", 700)]);
      expect(p.asked).toEqual(["no gym"]);
    }
    expect(JSON.stringify(phone.data.plan(date))).toBe(JSON.stringify(n.data.plan(date)));

    // Accepting a again, or at a version gone by: refused, with the plan as it is.
    const stale = await phone.data.accept(date, null, [block("a", 660)], seen.proposal!.id).catch((e) => e);
    expect(stale).toBeInstanceOf(Conflict);
    expect(stale.plan.proposal.blocks).toEqual([block("b", 700)]);
    expect(await phone.data.accept(date, seen.version, [block("b", 700)]).catch((e) => e)).toBeInstanceOf(Conflict);

    // b discarded; then nothing's open to accept.
    const now = phone.data.plan(date);
    expect((await phone.data.discard(date, now.version, now.proposal!.id)).proposal).toBeNull();
    expect(await phone.data.accept(date, null, []).catch((e) => e.message)).toBe("there's no proposal to accept");

    // The day edited, and the calendar written for the accept that's the plan's.
    const edited = await phone.data.setDay(date, null, [{ ...block("a", 660), pinned: true }]);
    expect(edited.day.blocks[0].pinned).toBe(true);
    expect((await n.data.calendarWritten(date, "2000-01-01T00:00:00Z", "d", { blocks: 1 })).calendar).toBeUndefined();
    await sync(phone, n);
    const written = await n.data.calendarWritten(date, n.data.plan(date).accepted!, "d", { blocks: 1 });
    expect(written.calendar).toMatchObject({ accepted: written.accepted, blocks: 1 });
    expect(n.data.planDates()).toEqual([date]);
    await phone.replicas.stop();
    n.stop();
  });

  it("keeps two devices' messages in order, and lets the user change one only until it's passed on", async () => {
    const n = await setup();
    const phone = await phoneOf(n);
    const mine = await phone.data.post("Matt", "hi", true);
    await Bun.sleep(2);
    const pepper = await n.data.post("pepper", "morning");
    await sync(phone, n, phone);
    for (const d of [n.data, phone.data]) expect(d.chat().map((m) => m.text)).toEqual(["hi", "morning"]);
    expect(n.data.chat(mine.id).map((m) => m.id)).toEqual([pepper.id]);
    expect(n.data.chat(undefined, 1).map((m) => m.id)).toEqual([pepper.id]);

    expect((await phone.data.edit(mine.id, "hello")).text).toBe("hello");
    expect(await n.data.edit(pepper.id, "x").catch((e) => e.message)).toBe(`no message ${pepper.id}`);
    const gone = await phone.data.post("Matt", "oops", true);
    await phone.data.unsay(gone.id);
    await sync(phone, n);
    expect(n.data.chat().map((m) => m.text)).toEqual(["hello", "morning"]);

    const delivered = await n.data.deliver(mine.id);
    expect(delivered.delivered).not.toBeNull();
    expect((await n.data.deliver(mine.id)).delivered).toBe(delivered.delivered);
    await sync(n, phone);
    expect(await phone.data.edit(mine.id, "too late").catch((e) => e)).toBeInstanceOf(Conflict);
    expect(await phone.data.unsay(mine.id).catch((e) => e)).toBeInstanceOf(Conflict);
    await phone.replicas.stop();
    n.stop();
  });
});

describe("day plans and chat over the node's MCP", () => {
  it("lets the user's clients and brains plan, and only a brain with chat talk", async () => {
    const n = await setup();
    const owner = n.oauth.mint("cli", 1, "owner");
    const pepper = n.oauth.mint("pepper", 1, "assistant", "assistant");
    const names = async (token: string) => ((await (await n.call("/mcp", rpc("tools/list", {}, token))).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    const tool = async (token: string, name: string, args: Record<string, unknown>) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, token)));

    expect(await names(owner)).toContain("plan_propose");
    expect(await names(owner)).not.toContain("chat_send");
    expect(await names(pepper)).not.toContain("chat_send");
    await n.data.putBrain("assistant", { abilities: ["chat"] });
    expect(await names(pepper)).toContain("chat_send");

    const blocks = [{ id: "a", start: 540, stop: 600, title: "Code: day.ts", kind: "work" }];
    const proposed = JSON.parse((await tool(pepper, "plan_propose", { date: "2026-11-05", blocks, projects: [{ key: "cb", name: "corkboard" }] })).text);
    expect(proposed.proposal).toMatchObject({ by: "assistant", blocks });
    expect(JSON.parse((await tool(owner, "plan_read", { date: "2026-11-05" })).text).proposal.id).toBe(proposed.proposal.id);
    expect((await tool(pepper, "plan_propose", { blocks: "no" })).text).toBe("blocks must be a list");

    const said = JSON.parse((await tool(pepper, "chat_send", { text: "Morning" })).text);
    expect(said).toMatchObject({ who: "assistant", text: "Morning", by_user: false });
    expect(JSON.parse((await tool(pepper, "chat_read", {})).text).map((m: { text: string }) => m.text)).toEqual(["Morning"]);
    expect((await tool(owner, "chat_send", { text: "x" })).text).toBe("unknown tool chat_send");
    n.stop();
  });
});

describe("Neovim's day plan, on the node", () => {
  it("answers plan.lua's operations as the Worker's, and tells each change once", async () => {
    const n = await setup();
    const date = "2026-11-05";
    const blocks = [{ id: "a", start: 540, stop: 600, title: "Code: app.ts", kind: "work" as const }];
    const told: DayEvent[] = [];
    await n.data.post("pepper", "before");
    const stop = dayEvents(n)((e) => told.push(e));
    expect(await plans(n, "plan_get", [date])).toMatchObject({ date, version: 0, proposal: null });
    expect(((await plans(n, "plan_say", [date, "later"])) as { plan: { asked: string[] } }).plan.asked).toEqual(["later"]);
    const p = await n.data.propose(date, { from: 0, blocks, reasons: [], why: {}, made: now(), by: "pepper" });
    expect(await plans(n, "plan_accept", [date, p.version - 1, blocks])).toMatchObject({ conflict: { proposal: { id: p.proposal!.id } } });
    expect(await plans(n, "plan_accept", [date, p.version, blocks])).toMatchObject({ plan: { proposal: null, day: { blocks } } });
    const day = (await plans(n, "plan_day", [date, null, [{ ...blocks[0], pinned: true }]])) as { plan: { day: { blocks: { pinned?: boolean }[] } } };
    expect(day.plan.day.blocks[0].pinned).toBe(true);
    expect(await plans(n, "plan_get", ["soon"]).catch((e) => e)).toBeInstanceOf(Invalid);

    const m = await n.data.post("Matt", "hi", true);
    await n.data.unsay(m.id);
    expect(told.map((e) => e.type)).toEqual(["plan", "plan", "plan", "plan", "chat", "chat-gone"]);
    stop();
    await n.data.post("pepper", "after");
    expect(told).toHaveLength(6);
    n.stop();
  });

  it("streams day events to another bridge with no board", async () => {
    const n = await setup();
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, appEvents: () => (fn) => dayEvents(n)((e) => fn(null, e)) });
    const res = await app(new Request(`${ORIGIN}/app/events`, { headers: { Authorization: `Bearer ${n.oauth.mint("dev bridge", 1, "owner")}` } }), { requestIP: () => ({ address: "127.0.0.1" }) });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(": up\n\n");
    await n.data.post("pepper", "morning");
    expect(JSON.parse((await reader.read()).value!.replace(/^data: /, ""))).toMatchObject({ key: null, event: { type: "chat", message: { text: "morning" } } });
    await reader.cancel();
    n.stop();
  });

  it("tells pepperd the day changed, over the tunnel, until it hangs up", async () => {
    const n = await setup();
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN });
    const res = await app(new Request(`${ORIGIN}/api/node/day/events`, { headers: { Authorization: `Bearer ${n.oauth.mint("pepperd", 1, "assistant", "assistant")}` } }), { requestIP: () => ({ address: "10.0.0.2" }) });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(": up\n\n");
    await n.data.post("Matt", "morning", true);
    expect((await reader.read()).value).toBe('data: {"kind":"day"}\n\n');
    await reader.cancel();
    // Hung up: nothing more is sent to it.
    await n.data.post("Matt", "again", true);
    expect((await app(new Request(`${ORIGIN}/api/node/day/events`), { requestIP: () => ({ address: "10.0.0.2" }) })).status).toBe(401);
    n.stop();
  });
});

describe("day plans and chat, the phone's API", () => {
  it("plans and chats over /api/node, with a 409 for a stale accept", async () => {
    const n = await setup();
    const owner = n.oauth.mint("phone", 1, "owner");
    const pepper = n.oauth.mint("pepper", 1, "assistant", "assistant");
    const api = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await n.call(`/api/node/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };
    const blocks = [{ id: "a", start: 540, stop: 600, title: "Code: day.ts", kind: "work" as const }];
    expect((await api(owner, "POST", "plans/2026-11-05/say", { text: "later" })).body.asked).toEqual(["later"]);
    const p = await n.data.propose("2026-11-05", { from: 0, blocks, reasons: [], why: {}, made: "2026-11-05T08:00:00Z", by: "assistant" });
    expect((await api(pepper, "POST", "plans/2026-11-05/accept", { blocks })).status).toBe(403);
    const stale = await api(owner, "POST", "plans/2026-11-05/accept", { blocks, version: p.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.plan.proposal.id).toBe(p.proposal!.id);
    const ok = await api(owner, "POST", "plans/2026-11-05/accept", { blocks, version: p.version, proposal: p.proposal!.id });
    expect(ok.body).toMatchObject({ proposal: null, day: { blocks } });
    expect((await api(pepper, "GET", "plans/2026-11-05")).body.accepted).toBe(ok.body.accepted);

    const mine = (await api(owner, "POST", "chat", { text: "hi", who: "Matt" })).body;
    expect(mine).toMatchObject({ who: "Matt", by_user: true, delivered: null });
    expect((await api(pepper, "POST", "chat", { text: "hello" })).body).toMatchObject({ who: "assistant", by_user: false });
    expect((await api(owner, "PATCH", `chat/${mine.id}`, { text: "hey" })).body.text).toBe("hey");
    expect((await api(owner, "POST", `chat/${mine.id}/delivered`)).body.delivered).not.toBeNull();
    expect((await api(owner, "DELETE", `chat/${mine.id}`)).status).toBe(409);
    expect((await api(owner, "GET", `chat?after=${mine.id}`)).body.map((m: { text: string }) => m.text)).toEqual(["hello"]);
    expect((await api(owner, "DELETE", "chat/nope")).status).toBe(404);
    n.stop();
  });
});

describe("the machine's sessions, on a channel", () => {
  it("serves its bridges' sessions to the account's devices, sealed, and takes a bridge on loopback", async () => {
    const n = await setup();
    const hub = new Hub();
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, hub });
    // A bridge in this process, with one session and a terminal.
    const typed: unknown[] = [];
    const term: unknown[] = [];
    let to: TerminalOut | undefined;
    const watchers: (() => void)[] = [];
    let sessions: Hosted[] = [{ key: "1-2", name: "Fixing", state: "working", project: "proj" }];
    serve("laptop-1", "laptop", {
      list: () => sessions,
      watch: (fn) => void watchers.push(fn),
      say: async (key, text, keys) => (typed.push([key, text, keys]), { ok: true }),
      screen: async (key) => (key === "1-2" ? { lines: ["$ hi"], width: 80 } : { error: "no such", missing: true }),
      terminals: (t) => ((to = t), { open: (s, k) => term.push(["open", k]), input: (s, d) => (term.push(["in", d]), to!.out(s, "echo")), size: (s, r, c) => void term.push(["size", r, c]), close: () => void term.push(["close"]) }),
      hub: joinHub(hub),
    });
    const keys = accountKeys(newRoot());
    const id = (name: string, role?: "relay"): Identity => {
      const d = newDevice();
      return { device: d, cert: certify(keys, d, name, Date.now(), role), trust: (c) => checkCert(keys.id, c, []) };
    };
    const open = async (me: Identity) => {
      const here = id("node");
      let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
      a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
      b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
      const [ch] = await Promise.all([initiate(a.link, me, here.device.id), respond(b.link, here, { serve: (req, c) => app(req, undefined, c.peer) })]);
      return ch;
    };
    const ch = await open(id("phone"));
    const list = (await (await ch.fetch("/api/sessions")).json()) as any[];
    expect(list).toMatchObject([{ id: "laptop-1", environment: "laptop", sessions: [{ key: "1-2", name: "Fixing", terminal: true }] }]);
    expect(await (await ch.fetch("/api/sessions/laptop-1/1-2")).json()).toEqual({ lines: ["$ hi"], width: 80 });
    expect((await ch.fetch("/api/sessions/laptop-1/9-9")).status).toBe(404);
    expect((await ch.fetch("/api/sessions/laptop-1/1-2/say", { method: "POST", body: JSON.stringify({ text: "go", keys: ["enter"] }) })).status).toBe(200);
    expect((await ch.fetch("/api/sessions/laptop-1/1-2/say", { method: "POST", body: JSON.stringify({ keys: ["meta"] }) })).status).toBe(400);
    expect(typed).toEqual([["1-2", "go", ["enter"]]]);
    // Following the list: it whole, then each change.
    const follow = (await ch.fetch("/api/sessions?follow")).body!.getReader();
    const next = async (r: ReadableStreamDefaultReader<Uint8Array>) => JSON.parse(new TextDecoder().decode((await r.read()).value!).trim());
    expect(await next(follow)).toMatchObject({ type: "bridges", bridges: [{ id: "laptop-1" }] });
    sessions = [{ key: "1-2", name: "Fixing", state: "idle" }];
    watchers.forEach((fn) => fn());
    expect(await next(follow)).toMatchObject({ type: "bridge", bridge: { id: "laptop-1", sessions: [{ state: "idle" }] } });
    await follow.cancel();
    // Its terminal, both ways.
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const res = await ch.fetch("/api/sessions/laptop-1/1-2/attach?terminal", { method: "POST", body: input.readable, duplex: "half" } as RequestInit);
    const w = input.writable.getWriter();
    await w.write(utf8(JSON.stringify({ type: "size", rows: 24, cols: 80 }) + "\n" + JSON.stringify({ type: "in", data: "eA" }) + "\n"));
    const r = res.body!.getReader();
    expect(await next(r)).toEqual({ type: "out", data: "echo" });
    await r.cancel();
    await Bun.sleep(10);
    expect(term).toEqual([["open", "1-2"], ["size", 24, 80], ["in", "eA"], ["close"]]);
    ch.close();
    // Not to a relay-only device, nor through the tunnel.
    const fleetd = await open(id("fleetd", "relay"));
    expect((await fleetd.fetch("/api/sessions")).status).toBe(404);
    fleetd.close();
    const owner = n.oauth.mint("dev bridge", 1, "owner");
    expect((await app(new Request(`${ORIGIN}/api/sessions`, { headers: { Authorization: `Bearer ${owner}` } }))).status).toBe(404);
    // A bridge on loopback: what the hub says as events, what it says POSTed.
    const local = { requestIP: () => ({ address: "127.0.0.1" }) };
    const live = await app(new Request(`${ORIGIN}/app/sessions/live?bridge=dev-2&machine=laptop`, { headers: { Authorization: `Bearer ${owner}` } }), local);
    expect(live.status).toBe(200);
    const post = (body: unknown) => app(new Request(`${ORIGIN}/app/sessions?bridge=dev-2`, { method: "POST", headers: { Authorization: `Bearer ${owner}` }, body: JSON.stringify(body) }), local);
    expect((await post([{ type: "sessions", environment: "laptop", sessions: [{ key: "3-4", name: "Dev" }] }])).status).toBe(200);
    expect(hub.bridges().map((b) => b.id)).toEqual(["dev-2", "laptop-1"]);
    const events = live.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await events.read()).value).toBe(": up\n\n");
    const asked = hub.ask("dev-2", { type: "screen", key: "3-4" });
    const q = JSON.parse((await events.read()).value!.replace(/^data: /, ""));
    expect(q).toMatchObject({ type: "screen", key: "3-4" });
    await post([{ type: "answer", ask: q.ask, lines: ["dev"], width: 10 }]);
    expect((await asked).value).toEqual({ lines: ["dev"], width: 10 });
    await events.cancel();
    expect(hub.bridges().map((b) => b.id)).toEqual(["laptop-1"]);
    expect((await app(new Request(`${ORIGIN}/app/sessions/live?bridge=dev-2`, { headers: { Authorization: `Bearer ${owner}` } }), { requestIP: () => ({ address: "10.0.0.2" }) })).status).toBe(404);
    await n.stop();
  });
  it("watches every hub of the account's: its own, and another device's on a channel", async () => {
    const n = await setup();
    const keys = accountKeys(newRoot());
    const ident = (name: string): Identity => {
      const d = newDevice();
      return { device: d, cert: certify(keys, d, name, Date.now()), trust: (c) => checkCert(keys.id, c, []) };
    };
    const [here, there] = [ident("laptop"), ident("desktop")];
    // Each machine's hub, with a bridge on it.
    const bridge = (hub: Hub, id: string, term: unknown[] = []) => {
      const watchers: (() => void)[] = [];
      const b = { sessions: [{ key: "1-2", name: id, state: "working" }] as Hosted[], tell: () => watchers.forEach((fn) => fn()) };
      let to: TerminalOut;
      serve(id, id, {
        list: () => b.sessions,
        watch: (fn) => void watchers.push(fn),
        say: async (key, text) => (term.push(["say", key, text]), { ok: true }),
        terminals: (t) => ((to = t), { open: (st) => (term.push(["open"]), to.out(st, "hi")), input: (st, d) => void term.push(["in", d]), size: () => {}, close: () => void term.push(["close"]) }),
        hub: joinHub(hub),
      });
      return b;
    };
    const [mine, theirs] = [new Hub(), new Hub()];
    bridge(mine, "laptop-1");
    const term: unknown[] = [];
    const desk = bridge(theirs, "desktop-1", term);
    const far = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, hub: theirs });
    let a: ReturnType<typeof pipe>, b: ReturnType<typeof pipe>;
    a = pipe((m) => queueMicrotask(() => b.deliver(m)), (r) => b.end(r));
    b = pipe((m) => queueMicrotask(() => a.deliver(m)), (r) => a.end(r));
    const [ch] = await Promise.all([initiate(a.link, here, there.device.id), respond(b.link, there, { serve: (req, c) => far(req, undefined, c.peer) })]);
    const me = here.device.id;
    const reach: Reach = {
      devices: async () => ({ me, devices: [me, there.device.id] }),
      fetch: async (device, path, init = {}) => (device === me ? (await mine.serve(new Request(`http://node.invalid${path}`, { ...init, ...(init.body != null && { duplex: "half" }) } as RequestInit)))! : ch.fetch(path, init)),
    };
    // The node's loopback way to them, for another bridge's process.
    const app = node({ data: n.data, search: n.search, oauth: n.oauth, origin: ORIGIN, hub: mine, reach });
    const owner = n.oauth.mint("dev bridge", 1, "owner");
    const local = { requestIP: () => ({ address: "127.0.0.1" }) };
    const get = (path: string, peer = local) => app(new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${owner}` } }), peer);
    expect(await (await get("/app/peers")).json()).toEqual({ me, devices: [me, there.device.id] });
    expect(await (await get(`/app/peer/${there.device.id}/api/sessions`)).json()).toMatchObject([{ id: "desktop-1" }]);
    expect((await get(`/app/peer/${there.device.id}/mcp`)).status).toBe(404);
    expect((await get("/app/peers", { requestIP: () => ({ address: "10.0.0.2" }) })).status).toBe(404);
    // Both machines' bridges, but this one's own.
    const peers = new Peers(reach);
    const events: PeerEvent[] = [];
    peers.on((e) => events.push(e));
    for (let i = 0; i < 50 && peers.list().length < 2; i++) await Bun.sleep(5);
    expect(peers.list("laptop-1").map((p) => [p.id, p.device])).toEqual([["desktop-1", there.device.id]]);
    expect(peers.list().length).toBe(2);
    // A change there, as it happens.
    desk.sessions = [{ key: "1-2", name: "desktop-1", state: "idle" }];
    desk.tell();
    for (let i = 0; i < 50 && !events.some((e) => "sessions" in e && e.sessions[0]?.state === "idle"); i++) await Bun.sleep(5);
    expect(events.at(-1)).toMatchObject({ id: "desktop-1", sessions: [{ state: "idle" }] });
    // Its terminal, both ways, on the channel; and what's typed.
    const out: unknown[] = [];
    let ended = 0;
    const t = peers.attach("desktop-1", "1-2", true, (m) => out.push(m), () => ended++);
    for (let i = 0; i < 50 && !out.length; i++) await Bun.sleep(5);
    expect(out).toEqual([{ type: "out", data: "hi" }]);
    t.send({ type: "in", data: "eA" });
    for (let i = 0; i < 50 && term.length < 2; i++) await Bun.sleep(5);
    t.close();
    for (let i = 0; i < 50 && term.length < 3; i++) await Bun.sleep(5);
    expect(term).toEqual([["open"], ["in", "eA"], ["close"]]);
    expect(ended).toBe(1);
    expect((await peers.fetch("desktop-1", "/api/sessions/desktop-1/1-2/say", { method: "POST", body: JSON.stringify({ text: "go" }) })).status).toBe(200);
    expect((await peers.fetch("nobody", "/api/sessions/nobody/1-2/say", { method: "POST", body: "{}" })).status).toBe(404);
    // The device gone: its bridges with it.
    reach.devices = async () => ({ me, devices: [me] });
    await (peers as any).look();
    expect(peers.list().map((p) => p.id)).toEqual(["laptop-1"]);
    expect(events.at(-1)).toEqual({ id: "desktop-1", gone: true });
    peers.stop();
    ch.close();
    await n.stop();
  });
});
