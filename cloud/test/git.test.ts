import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken, worker } from "./login";

// The portal's Forgejo browser (git.ts), against a fake Forgejo at git.test.

let owner: string;
let calls: { url: string; auth: string | null }[];

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// Forgejo as far as git.ts reads it.
function fakeForgejo() {
  calls = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith("https://git.test/")) return real(input, init);
    calls.push({ url: req.url, auth: req.headers.get("Authorization") });
    const path = new URL(req.url).pathname;
    // git's smart HTTP, with the token as the user name.
    if (path.startsWith("/mattjurenka/corkboard.git/")) {
      if (req.headers.get("Authorization") !== `Basic ${btoa("forgejo-token:x-oauth-basic")}`) return new Response("", { status: 401 });
      if (path.endsWith("/info/refs")) return new Response("001e# service=git-upload-pack\n0000", { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } });
      return new Response(`pack for ${req.headers.get("Content-Type")} ${req.headers.get("Git-Protocol")}: ${await req.text()}`, { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    }
    if (req.headers.get("Authorization") !== "token forgejo-token") return Response.json({ message: "token is required" }, { status: 401 });
    if (path === "/api/v1/user/repos") return Response.json([{ owner: { login: "mattjurenka" }, name: "corkboard", private: true, default_branch: "main", updated_at: "2026-10-30T00:00:00Z" }]);
    if (path === "/api/v1/repos/mattjurenka/corkboard") return Response.json({ owner: { login: "mattjurenka" }, name: "corkboard", default_branch: "main" });
    if (path === "/api/v1/repos/mattjurenka/corkboard/branches")
      return Response.json([
        { name: "fleet/x", commit: { id: "bbb", message: "Fix the tree\n\nDetails.", timestamp: "2026-10-30T02:00:00Z", author: { name: "agent" } } },
        { name: "main", commit: { id: "aaa", message: "Release", timestamp: "2026-10-29T00:00:00Z", author: { name: "Matt" } } },
      ]);
    const cmp = path.match(/^\/api\/v1\/repos\/mattjurenka\/corkboard\/compare\/(\w+)\.\.\.(\w+)$/);
    if (cmp) return Response.json({ total_commits: cmp[1] === "aaa" ? 3 : 1 });
    if (path === "/api/v1/repos/mattjurenka/corkboard/contents")
      return Response.json([
        { name: "README.md", path: "README.md", type: "file", size: 5 },
        { name: "cloud", path: "cloud", type: "dir", size: 0 },
      ]);
    if (path === "/api/v1/repos/mattjurenka/corkboard/contents/cloud/a%20b.ts") return Response.json({ name: "a b.ts", path: "cloud/a b.ts", size: 8, content: b64("héllo\n") });
    if (path === "/api/v1/repos/mattjurenka/corkboard/contents/logo.png") return Response.json({ name: "logo.png", path: "logo.png", size: 3, content: btoa("\x89P\0") });
    return Response.json({ message: "not found" }, { status: 404 });
  });
}

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  worker(path, { ...init, headers: { Authorization: `Bearer ${init.token ?? owner}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } });

beforeEach(async () => {
  owner = await ownerToken();
  fakeForgejo();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("browsing Forgejo", () => {
  it("says where Forgejo is, and never hands out its token", async () => {
    const res = await api("/api/git");
    expect(await res.json()).toEqual({ origin: "https://git.test" });
  });

  it("lists repos, a repo's branches, a directory and a file, with the Worker's token", async () => {
    const repos = await (await api("/api/git/repos")).json<any[]>();
    expect(repos).toEqual([expect.objectContaining({ owner: "mattjurenka", name: "corkboard", private: true })]);
    expect(calls.at(-1)!.auth).toBe("token forgejo-token");

    expect(await (await api("/api/git/repos/mattjurenka/corkboard")).json()).toMatchObject({ default_branch: "main", branches: ["fleet/x", "main"] });
    const root = await (await api("/api/git/repos/mattjurenka/corkboard/contents")).json<any>();
    expect(root.entries.map((e: any) => e.name)).toEqual(["cloud", "README.md"]);

    const f = await (await api("/api/git/repos/mattjurenka/corkboard/contents/cloud/a%20b.ts?ref=main")).json<any>();
    expect(f).toMatchObject({ type: "file", content: "héllo\n", binary: false });
    expect(calls.at(-1)!.url).toBe("https://git.test/api/v1/repos/mattjurenka/corkboard/contents/cloud/a%20b.ts?ref=main");
    expect(await (await api("/api/git/repos/mattjurenka/corkboard/contents/logo.png")).json()).toMatchObject({ binary: true });
    expect((await api("/api/git/repos/mattjurenka/corkboard/contents/nope")).status).toBe(404);
  });

  it("lists branches, the default first, with how far each is from it", async () => {
    const list = await (await api("/api/git/repos/mattjurenka/corkboard/branches")).json<any[]>();
    expect(list).toEqual([
      { name: "main", sha: "aaa", message: "Release", author: "Matt", date: "2026-10-29T00:00:00Z", default: true, ahead: null, behind: null },
      { name: "fleet/x", sha: "bbb", message: "Fix the tree", author: "agent", date: "2026-10-30T02:00:00Z", default: false, ahead: 3, behind: 1 },
    ]);
    expect(calls.some((c) => c.url.endsWith("/compare/aaa...bbb"))).toBe(true);
  });

  it("passes git's smart HTTP through for a clone, upload-pack only", async () => {
    const refs = await api("/api/git/repos/mattjurenka/corkboard.git/info/refs?service=git-upload-pack");
    expect(refs.status).toBe(200);
    expect(refs.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await refs.text()).toBe("001e# service=git-upload-pack\n0000");
    expect(calls.at(-1)!.url).toBe("https://git.test/mattjurenka/corkboard.git/info/refs?service=git-upload-pack");
    const pack = await worker("/api/git/repos/mattjurenka/corkboard/git-upload-pack", {
      method: "POST",
      body: "0032want aaa\n",
      headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/x-git-upload-pack-request", "Git-Protocol": "version=2" },
    });
    expect(await pack.text()).toBe("pack for application/x-git-upload-pack-request version=2: 0032want aaa\n");
    // Pushing is another service, and isn't here.
    expect((await api("/api/git/repos/mattjurenka/corkboard/info/refs?service=git-receive-pack")).status).toBe(403);
    expect((await api("/api/git/repos/mattjurenka/corkboard/git-receive-pack", { method: "POST", body: "x" })).status).toBe(405);
    expect((await api("/api/git/repos/mattjurenka/corkboard/git-upload-pack")).status).toBe(405);
    expect((await worker("/api/git/repos/mattjurenka/corkboard/info/refs?service=git-upload-pack")).status).toBe(401);
    expect(calls.length).toBe(2);
  });

  it("refuses bad names, paths and refs, and anything but reading", async () => {
    expect((await api("/api/git/repos/mattjurenka/corkboard/contents/a%2F..%2F..%2Fsecrets")).status).toBe(400);
    expect((await api("/api/git/repos/matt%20j/corkboard")).status).toBe(400);
    expect((await api("/api/git/repos/mattjurenka/corkboard/contents?ref=a%20b")).status).toBe(400);
    expect((await api("/api/git/repos", { method: "POST", body: "{}" })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("is the owner's: not a machine token's, nor anyone signed out", async () => {
    const machine = (await (await api("/api/tokens/machine", { method: "POST", body: JSON.stringify({ environment: "cloud" }) })).json<{ token: string }>()).token;
    expect((await api("/api/git/repos", { token: machine })).status).toBe(403);
    expect((await worker("/api/git/repos")).status).toBe(401);
    expect(calls).toEqual([]);
  });
});
