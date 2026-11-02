import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot } from "../../lib/e2ee/keys";
import { type LogTransport, Replica } from "../../lib/e2ee/sync";
import { type NewOp, type WireOp, b64url } from "../../lib/e2ee/wire";
import { listObjects, noteRecord } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { OAuthStore, publicAddress, redirectAllowed, sameRedirect } from "./oauth";
import { node, originOf } from "./server";

// A relay in memory: a log per object, ordered by pos, as the Worker keeps them.
function relay(): LogTransport {
  const logs = new Map<string, WireOp[]>();
  return {
    async append(object: string, ops: NewOp[]) {
      const log = logs.get(object) ?? [];
      logs.set(object, log);
      return ops.map((o) => {
        const had = log.find((w) => w.id === o.id);
        if (had) return { id: o.id, pos: had.pos };
        const w: WireOp = { ...o, device: DEVICE_OF.get(o.id) ?? "?", pos: log.length + 1, ts: new Date().toISOString() };
        log.push(w);
        return { id: o.id, pos: w.pos };
      });
    },
    async read(object: string, since: number) {
      const log = logs.get(object) ?? [];
      return { ops: log.filter((w) => w.pos > since), head: log.length };
    },
  };
}
// The relay labels an op with the device that signed in to push it; here,
// each pushing transport says which device it is.
const DEVICE_OF = new Map<string, string>();
const as = (t: LogTransport, device: string): LogTransport => ({
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
  const app = node({ data, search, oauth, origin: ORIGIN });
  // Another device of the account: the laptop, on the same relay.
  const board = objects.find((o) => o.kind === "board")!;
  const laptop = await Replica.open({ transport: as(shared, "laptop"), key: board.key, object: board.object, device: "laptop" });
  const call = (path: string, init: RequestInit = {}) => app(new Request(`${ORIGIN}${path}`, init));
  return { dir, root, replicas, data, search, oauth, app, call, laptop, stop: () => replicas.stop() };
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
    expect(made.id).toBe("TASK-2");
    const read = JSON.parse((await tool("read_card", { board: "proj", id: "TASK-1" })).text);
    expect(read.log).toContain("half way");
    expect(read.log).toContain("follow-up: TASK-2");
    const err = await tool("update_card", { board: "proj", id: "TASK-2", agent_state: "working" });
    expect(err.error).toBe(true);
    expect(err.text).toContain("claim it first");
    expect((await tool("read_card", { board: "proj", id: "TASK-9" })).error).toBe(true);

    await n.replicas.settled();
    await n.laptop.pull();
    const cards = n.laptop.cards();
    expect(cards.map((c) => c.id)).toEqual(["TASK-1", "TASK-2"]);
    expect(cards[0].agent).toBe("assistant");
    expect(cards[0].log.map((e) => e.note)).toEqual(["claimed", "half way", "follow-up: TASK-2"]);
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
    expect(made.body.id).toBe("TASK-1");
    expect((await api("PATCH", "boards/proj/cards/task-1", { status: "doing" })).body.status).toBe("doing");
    expect((await api("PATCH", "boards/proj/cards/TASK-1", { nonsense: 1 })).status).toBe(400);
    expect((await api("POST", "boards/proj/cards/TASK-1/log", { note: "on the train" })).body.who).toBe("phone");
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
