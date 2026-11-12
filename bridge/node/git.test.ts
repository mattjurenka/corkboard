import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "./oauth";
import { node } from "./server";

// Forgejo's API as the views read it, and what was asked.
const asked: string[] = [];
const toForge = async (path: string, init: RequestInit = {}) => {
  asked.push(`${init.method ?? "GET"} ${path}`);
  const at = path.replace(/\?.*$/, "");
  if (at === "/api/v1/user") return Response.json({ login: "matt", html_url: "https://git.example/matt" });
  if (at === "/api/v1/user/repos") return Response.json([{ owner: { login: "matt" }, name: "old", updated_at: "2026-01-01" }, { owner: { login: "matt" }, name: "new", updated_at: "2026-02-01", private: true }]);
  if (at === "/api/v1/repos/matt/new") return Response.json({ owner: { login: "matt" }, name: "new", default_branch: "main" });
  if (at === "/api/v1/repos/matt/new/branches") return Response.json([{ name: "agent/x", commit: { id: "b", timestamp: "2026-02-02" } }, { name: "main", commit: { id: "a", timestamp: "2026-02-01" } }]);
  if (at.startsWith("/api/v1/repos/matt/new/compare/")) return Response.json({ total_commits: at.endsWith("a...b") ? 2 : 0 });
  if (at === "/api/v1/repos/matt/new/contents") return Response.json([{ name: "a.ts", path: "a.ts", type: "file", size: 1 }, { name: "src", path: "src", type: "dir", size: 0 }]);
  if (at === "/api/v1/repos/matt/new/contents/a.ts") return Response.json({ name: "a.ts", path: "a.ts", size: 2, content: btoa("hi") });
  if (at === "/matt/new.git/info/refs") return new Response("REFS", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
  return Response.json({ message: "not found" }, { status: 404 });
};

describe("the node's git views", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-"));
  const oauth = new OAuthStore(join(dir, "oauth.json"));
  const none = {} as any;
  let on = false;
  const app = node({ data: none, search: none, oauth, origin: "https://relay/n/h", toForge, forgeWeb: () => on });
  const owner = oauth.mint("portal", 1, "owner");
  const get = (path: string, token = owner, peer?: any) => app(new Request(`https://relay/api/node/git${path}`, { headers: { Authorization: `Bearer ${token}` } }), peer);

  it("are the owner's, and through the tunnel only while the forge's pages are on", async () => {
    expect((await get("")).status).toBe(404);
    expect((await get("", owner, { requestIP: () => ({ address: "127.0.0.1" }) })).status).toBe(200);
    on = true;
    expect(await (await get("")).json()).toEqual({ origin: "https://git.example" });
    expect((await get("", oauth.mint("session", 1, "assistant"))).status).toBe(404);
  });

  it("list repositories, branches and contents as the Worker's did", async () => {
    expect(((await (await get("/repos")).json()) as any[]).map((r) => r.name)).toEqual(["new", "old"]);
    expect(await (await get("/repos/matt/new")).json()).toMatchObject({ name: "new", default_branch: "main", branches: ["agent/x", "main"] });
    expect(await (await get("/repos/matt/new/branches")).json()).toMatchObject([{ name: "main", default: true }, { name: "agent/x", ahead: 2, behind: 0 }]);
    expect(((await (await get("/repos/matt/new/contents")).json()) as any).entries.map((e: any) => e.name)).toEqual(["src", "a.ts"]);
    expect(await (await get("/repos/matt/new/contents/a.ts")).json()).toMatchObject({ type: "file", content: "hi", binary: false });
    expect((await get("/repos/matt/new/contents/..%2Fx")).status).toBe(400);
  });

  it("carry git's upload-pack, and nothing else of git's", async () => {
    const refs = await get("/repos/matt/new.git/info/refs?service=git-upload-pack");
    expect(await refs.text()).toBe("REFS");
    expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect((await get("/repos/matt/new/info/refs?service=git-receive-pack")).status).toBe(403);
    rmSync(dir, { recursive: true });
  });
});
