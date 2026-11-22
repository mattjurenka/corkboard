import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot } from "../../lib/e2ee/keys";
import { offline } from "../../lib/e2ee/sync";
import { b64url } from "../../lib/e2ee/wire";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { type Net, OAuthStore, pinnedFetch } from "./oauth";
import { node } from "./server";

const ORIGIN = "https://node.test";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
// Each test's clock is the real one again after it.
afterEach(() => void setSystemTime());

// The internet, as a client id document's host: one server on this machine,
// every https URL's path served from it as if from a public address, with
// what it was asked counted.
function internet() {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response | Promise<Response> {
      const p = new URL(req.url).pathname;
      hits.push(p);
      const id = `https://client.example${p}`;
      const doc = (o: Record<string, unknown> = {}) => Response.json({ client_id: id, client_name: "Client", redirect_uris: ["https://client.example/cb"], ...o });
      if (p === "/client.json") return doc();
      if (p === "/other-id.json") return doc({ client_id: "https://client.example/client.json" });
      if (p === "/http-redirect.json") return doc({ redirect_uris: ["http://evil.example/cb"] });
      if (p === "/secret.json") return doc({ token_endpoint_auth_method: "client_secret_basic" });
      if (p === "/no-uris.json") return doc({ redirect_uris: [] });
      if (p === "/moved.json") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${server.port}/internal` } });
      if (p === "/missing.json") return Response.json({ error: "no" }, { status: 404 });
      if (p === "/html.json") return new Response("<html>");
      if (p === "/big.json") return new Response(JSON.stringify({ client_id: id, pad: "x".repeat(70 * 1024) }));
      // Without end, a little at a time.
      if (p === "/endless.json")
        return new Response(new ReadableStream({ pull: async (c) => (await Bun.sleep(1), c.enqueue(new TextEncoder().encode(" ".repeat(8192)))) }));
      if (p === "/slow.json") return Bun.sleep(5_000).then(() => doc());
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const resolved: string[] = [];
  const net = (addresses: string[] = ["160.79.104.10"], timeout?: number): Net => ({
    lookup: async (host) => (resolved.push(host), addresses.map((address) => ({ address }))),
    fetch: (url, init) => fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init),
    ...(timeout && { timeout }),
  });
  return { hits, resolved, net, stop: () => server.stop(true) };
}

async function setup(net?: Net) {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-oauth-"));
  dirs.push(dir);
  const replicas = await Replicas.open({ objects: listObjects(newRoot(), { boards: [], brains: ["assistant"] }), transport: offline, device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const oauth = new OAuthStore(join(dir, "oauth.json"), undefined, net);
  const app = node({ data, search: new Search(data), oauth, origin: ORIGIN });
  const call = (path: string, init: RequestInit = {}) => app(new Request(`${ORIGIN}${path}`, init));
  return { dir, oauth, call, stop: () => replicas.stop() };
}

// A store for its client id documents alone, in a directory of its own.
function documents(net: Net) {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-oauth-"));
  dirs.push(dir);
  return new OAuthStore(join(dir, "oauth.json"), undefined, net);
}

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const form = (o: Record<string, string>, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(o).toString() });
const ask = (client_id: string, redirect_uri: string, more: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", ...more });
const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

// Through the consent page, approved with a fresh approval code (and the
// sessions' box ticked, with drive): the client's code.
async function consent(n: Awaited<ReturnType<typeof setup>>, client_id: string, redirect: string, more: Record<string, string> = {}) {
  const page = await (await n.call(`/authorize?${ask(client_id, redirect, more)}`)).text();
  const request = page.match(/name="request" value="([^"]+)"/)![1];
  return { request, approve: async (drive = false) => new URL((await n.call("/authorize", form({ request, code: n.oauth.newApproval(), action: "approve", ...(drive ? { drive: "1" } : {}) }))).headers.get("Location")!).searchParams.get("code")! };
}

// The fetch the node makes: to the addresses the check found, whatever the
// name resolves to by then. client.example resolves to nothing; its TLS
// hello reaches 127.0.0.1, still for the name.
describe("pinnedFetch", () => {
  it("connects to the address it's given, for the name", async () => {
    const hello = Promise.withResolvers<Buffer>();
    const server = createServer((socket) => socket.once("data", (d: Buffer) => (hello.resolve(d), socket.destroy())));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const fetched = pinnedFetch(new URL(`https://client.example:${port}/client.json`), { signal: AbortSignal.timeout(5_000) }, [{ address: "127.0.0.1" }]);
      expect((await hello.promise).includes("client.example")).toBe(true);
      await expect(fetched).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe("a client id metadata document", () => {
  let web: ReturnType<typeof internet>;
  beforeAll(() => void (web = internet()));
  afterAll(() => web.stop());

  it("is a client: fetched from its public host, kept an hour, and through the code flow with no secret", async () => {
    const n = await setup(web.net());
    const id = "https://client.example/client.json";
    const redirect = "https://client.example/cb";
    const page = await n.call(`/authorize?${ask(id, redirect, { state: "s" })}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Client");
    expect(web.resolved.at(-1)).toBe("client.example");
    const { approve } = await consent(n, id, redirect);
    const code = await approve();
    const tok = await n.call("/token", form({ grant_type: "authorization_code", code, client_id: id, redirect_uri: redirect, code_verifier: verifier }));
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string };
    expect(n.oauth.verify(t.access_token, ORIGIN)?.scope).toBe("assistant");
    // Three asks, one fetch; past the hour, fetched again.
    expect(web.hits.filter((p) => p === "/client.json")).toHaveLength(1);
    later(3600_000 + 1000);
    await n.oauth.client(id);
    expect(web.hits.filter((p) => p === "/client.json")).toHaveLength(2);
    // Its redirect is its document's, and nobody else's.
    expect((await n.call(`/authorize?${ask(id, "https://evil.example/cb")}`)).status).toBe(400);
    await n.stop();
  });

  it("is fetched from no private, loopback, link-local or unresolvable address", async () => {
    const id = (host: string) => `https://${host}/client.json`;
    const asked = web.hits.length;
    const looked = web.resolved.length;
    for (const host of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.10", "[::1]", "[fe80::1]", "[fd12::1]", "[::ffff:127.0.0.1]", "[::ffff:a9fe:a9fe]", "0.0.0.0"]) {
      const n = documents(web.net());
      await expect(n.client(id(host))).rejects.toThrow(/isn't a public address/);
    }
    // A name, by every address it has.
    for (const addresses of [["10.0.0.1"], ["160.79.104.10", "127.0.0.1"], ["::ffff:192.168.1.1"], ["fe80::2"]]) {
      const n = documents(web.net(addresses));
      await expect(n.client(id("client.example"))).rejects.toThrow(/isn't a public address/);
    }
    await expect(documents(web.net([])).client(id("client.example"))).rejects.toThrow(/can't resolve/);
    // None of them was asked, and an address needs no looking up.
    expect(web.hits.length).toBe(asked);
    expect(web.resolved.length).toBe(looked + 5);
  });

  it("is an https URL with a path, nothing else", async () => {
    const n = documents(web.net());
    for (const id of ["https://client.example", "https://client.example/", "https://client.example/c.json#x", "https://user:pw@client.example/client.json", "https://exa mple/x"])
      await expect(n.client(id)).rejects.toThrow(/https URL with a path|isn't a URL/);
    // Not https: a registered client's id, which it isn't.
    await expect(n.client("http://client.example/client.json")).rejects.toThrow(/no client/);
  });

  it("is refused when it redirects, fails, is too big or too slow, or isn't one this takes", async () => {
    const n = documents(web.net(undefined, 500));
    const doc = (p: string) => n.client(`https://client.example${p}`);
    await expect(doc("/moved.json")).rejects.toThrow(/couldn't read/);
    // The redirect isn't followed.
    expect(web.hits).not.toContain("/internal");
    await expect(doc("/missing.json")).rejects.toThrow(/couldn't read.*404/);
    await expect(doc("/html.json")).rejects.toThrow(/couldn't read/);
    await expect(doc("/big.json")).rejects.toThrow(/too big/);
    // One without end is cut off at its 64 KB, not read until the time's up.
    const started = Date.now();
    await expect(doc("/endless.json")).rejects.toThrow(/too big/);
    expect(Date.now() - started).toBeLessThan(500);
    await expect(doc("/slow.json")).rejects.toThrow(/couldn't read/);
    await expect(doc("/other-id.json")).rejects.toThrow(/names another client_id/);
    await expect(doc("/http-redirect.json")).rejects.toThrow(/redirect_uris/);
    await expect(doc("/no-uris.json")).rejects.toThrow(/redirect_uris/);
    await expect(doc("/secret.json")).rejects.toThrow(/authenticates with none/);
    // A refused one isn't kept: asked again, fetched again.
    await expect(doc("/missing.json")).rejects.toThrow();
    expect(web.hits.filter((p) => p === "/missing.json")).toHaveLength(2);
  });
});

describe("a confidential client", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => void (n = await setup()));
  afterAll(() => n.stop());
  const redirect = "https://app.example/cb";
  const register = async (method?: string) =>
    (await (await n.call("/register", { method: "POST", body: JSON.stringify({ client_name: "App", redirect_uris: [redirect], ...(method && { token_endpoint_auth_method: method }) }) })).json()) as { client_id: string; client_secret: string; token_endpoint_auth_method: string };
  const basic = (id: string, secret: string) => ({ Authorization: `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}` });
  const exchange = (code: string, client_id: string, auth: { headers?: Record<string, string>; secret?: string } = {}) =>
    n.call("/token", form({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, ...(auth.headers ? {} : { client_id }), ...(auth.secret !== undefined && { client_secret: auth.secret }) }, auth.headers));
  const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];

  it("is one with a secret by default, sent in Basic, and a code isn't spent by a wrong one", async () => {
    const c = await register();
    expect(c.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(c.client_secret).toMatch(/^cbs_/);
    const code = await (await consent(n, c.client_id, redirect)).approve();
    expect(await error(await exchange(code, c.client_id))).toEqual([401, "invalid_client"]);
    expect(await error(await exchange(code, c.client_id, { headers: basic(c.client_id, "cbs_wrong") }))).toEqual([401, "invalid_client"]);
    expect(await error(await exchange(code, c.client_id, { headers: basic(c.client_id, "") }))).toEqual([401, "invalid_client"]);
    // Another client's secret is no good either, nor its code another's.
    const other = await register();
    expect(await error(await exchange(code, c.client_id, { headers: basic(c.client_id, other.client_secret) }))).toEqual([401, "invalid_client"]);
    const ok = await exchange(code, c.client_id, { headers: basic(c.client_id, c.client_secret) });
    expect(ok.status).toBe(200);
    const theirs = await (await consent(n, c.client_id, redirect)).approve();
    expect(await error(await exchange(theirs, other.client_id, { headers: basic(other.client_id, other.client_secret) }))).toEqual([400, "invalid_grant"]);
    // Refreshing, too, is the client's alone.
    const { refresh_token } = (await ok.json()) as { refresh_token: string };
    expect(await error(await n.call("/token", form({ grant_type: "refresh_token", refresh_token, client_id: c.client_id })))).toEqual([401, "invalid_client"]);
    expect((await n.call("/token", form({ grant_type: "refresh_token", refresh_token }, basic(c.client_id, c.client_secret)))).status).toBe(200);
    // The secret isn't kept, only its hash.
    expect(await Bun.file(join(n.dir, "oauth.json")).text()).not.toContain(c.client_secret);
  });

  it("drives the user's sessions only when the box was ticked, and so after a refresh", async () => {
    const c = await register("client_secret_post");
    const token = async (drive: boolean) => {
      const code = await (await consent(n, c.client_id, redirect)).approve(drive);
      return (await (await exchange(code, c.client_id, { secret: c.client_secret })).json()) as { access_token: string; refresh_token: string };
    };
    expect(n.oauth.verify((await token(false)).access_token, ORIGIN)?.drive).toBeUndefined();
    // A wrong code gives the page back with the box as it was.
    const { request } = await consent(n, c.client_id, redirect);
    expect(await (await n.call("/authorize", form({ request, code: "WRONG", action: "approve", drive: "1" }))).text()).toContain('value="1" checked');
    const yes = await token(true);
    expect(n.oauth.verify(yes.access_token, ORIGIN)?.drive).toBe(true);
    const again = (await (await n.call("/token", form({ grant_type: "refresh_token", refresh_token: yes.refresh_token, client_id: c.client_id, client_secret: c.client_secret }))).json()) as { access_token: string };
    expect(n.oauth.verify(again.access_token, ORIGIN)?.drive).toBe(true);
  });

  it("may send its secret in the body", async () => {
    const c = await register("client_secret_post");
    const code = await (await consent(n, c.client_id, redirect)).approve();
    expect(await error(await exchange(code, c.client_id, { secret: "nope" }))).toEqual([401, "invalid_client"]);
    expect((await exchange(code, c.client_id, { secret: c.client_secret })).status).toBe(200);
  });

  it("is no client with a Basic header that names it and no secret", async () => {
    const c = await register();
    expect(await error(await n.call("/token", form({ grant_type: "authorization_code", code: "x" }, { Authorization: `Basic ${btoa(c.client_id)}` })))).toEqual([401, "invalid_client"]);
    expect(await error(await n.call("/token", form({ grant_type: "authorization_code", code: "x" }, { Authorization: "Basic" })))).toEqual([401, "invalid_client"]);
  });

  it("can't register an auth method or grant type there isn't", async () => {
    for (const body of [{ token_endpoint_auth_method: "private_key_jwt" }, { grant_types: ["client_credentials"] }, { redirect_uris: [] }]) {
      const res = await n.call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: [redirect], ...body }) });
      expect(res.status).toBe(400);
    }
  });
});

describe("consent", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let client_id: string;
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  beforeAll(async () => {
    n = await setup();
    client_id = n.oauth.register({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }).client_id as string;
  });
  afterAll(() => n.stop());

  it("denied, sends the client back with access_denied, and ends the request", async () => {
    const { request } = await consent(n, client_id, redirect, { state: "st" });
    const code = n.oauth.newApproval();
    const no = await n.call("/authorize", form({ request, code, action: "deny" }));
    expect(no.status).toBe(302);
    const back = new URL(no.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(Object.fromEntries(back.searchParams)).toEqual({ error: "access_denied", error_description: "the owner said no", state: "st", iss: ORIGIN });
    // Over: approving it now is too late, and saying no didn't spend the code.
    const after = await n.call("/authorize", form({ request, code, action: "approve" }));
    expect(after.status).toBe(400);
    expect(await after.text()).toContain("expired");
    expect(n.oauth.spendApproval(code)).toBe(true);
    // Anything but approve is a no.
    const { request: r2 } = await consent(n, client_id, redirect);
    expect(new URL((await n.call("/authorize", form({ request: r2, code: n.oauth.newApproval() }))).headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    // A request it never made.
    expect((await n.call("/authorize", form({ request: "nope", action: "deny" }))).status).toBe(400);
    expect((await n.call("/authorize", { method: "PUT" })).status).toBe(405);
  });

  it("lasts ten minutes, as do the approval code and the client's code", async () => {
    const { request } = await consent(n, client_id, redirect);
    later(10 * 60_000 + 1000);
    const late = await n.call("/authorize", form({ request, code: n.oauth.newApproval(), action: "approve" }));
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("expired");

    const stale = n.oauth.newApproval();
    const { request: r2 } = await consent(n, client_id, redirect);
    later(10 * 60_000 + 1000);
    const { request: r3 } = await consent(n, client_id, redirect);
    expect(await (await n.call("/authorize", form({ request: r3, code: stale, action: "approve" }))).text()).toContain("wrong code");
    expect((await n.call("/authorize", form({ request: r2, code: n.oauth.newApproval(), action: "approve" }))).status).toBe(400);

    const code = await (await consent(n, client_id, redirect)).approve();
    later(10 * 60_000 + 1000);
    const tok = await n.call("/token", form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier }));
    expect(tok.status).toBe(400);
    expect(((await tok.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("gives an hour's access, and a refresh token good for thirty days unused", async () => {
    const code = await (await consent(n, client_id, redirect)).approve();
    const t = (await (await n.call("/token", form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier }))).json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(t.expires_in).toBe(3600);
    later(3600_000 + 1000);
    expect(n.oauth.verify(t.access_token, ORIGIN)).toBeUndefined();
    const r = await n.call("/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }));
    const t2 = (await r.json()) as { access_token: string; refresh_token: string };
    expect(n.oauth.verify(t2.access_token, ORIGIN)?.scope).toBe("assistant");
    later(30 * 86_400_000 + 1000);
    expect((await n.call("/token", form({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id }))).status).toBe(400);
  });
});
