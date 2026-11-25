import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "./oauth";
import { node } from "./server";
import { PR_TOOLS, type PrCall, blocked, contents, overview, verdictOf } from "./prs";

// Forgejo's PR API for one repository, me/proj, in memory.
function forgejo() {
  const pulls: any[] = [];
  const reviews = new Map<number, any[]>();
  const merged: any[] = [];
  const comments: any[] = [];
  let at = 0;
  const forge = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, "http://forge.invalid");
    const p = url.pathname.replace(/^\/api\/v1\/repos\/me\/proj/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    let m: RegExpMatchArray | null;
    if (p === "" && method === "GET") return json({ default_branch: "main" });
    if (p === "/pulls" && method === "GET") return json(pulls.filter((x) => url.searchParams.get("state") === "all" || x.state === url.searchParams.get("state")));
    if (p === "/pulls" && method === "POST") {
      const pr = { number: pulls.length + 1, title: body.title, body: body.body ?? "", state: "open", merged: false, mergeable: true, head: { ref: body.head, sha: "a".repeat(40) }, base: { ref: body.base } };
      pulls.push(pr);
      return json(pr, 201);
    }
    if ((m = p.match(/^\/pulls\/(\d+)$/))) {
      const pr = pulls[Number(m[1]) - 1];
      if (!pr) return json({ message: "not found" }, 404);
      if (method === "PATCH") Object.assign(pr, body);
      return json(pr);
    }
    if ((m = p.match(/^\/pulls\/(\d+)\.diff$/))) return new Response("diff --git a/x b/x\n");
    if ((m = p.match(/^\/pulls\/(\d+)\/reviews$/))) {
      const n = Number(m[1]);
      if (method === "POST") {
        expect(body.event).toBe("COMMENT");
        reviews.set(n, [...(reviews.get(n) ?? []), { body: body.body, commit_id: body.commit_id, submitted_at: `2026-11-13T00:00:${String(at++).padStart(2, "0")}Z` }]);
        return json({});
      }
      return json(reviews.get(n) ?? []);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/)) && method === "POST") {
      comments.push({ number: Number(m[1]), body: body.body });
      return json({}, 201);
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/merge$/))) {
      const pr = pulls[Number(m[1]) - 1];
      if (body.head_commit_id !== pr.head.sha) return json({ message: "head moved" }, 409);
      merged.push(body);
      Object.assign(pr, { merged: true, state: "closed" });
      return new Response(null, { status: 200 });
    }
    if ((m = p.match(/^\/contents(\/.*)?$/))) {
      if (url.searchParams.get("ref") !== "main") return json({ message: "no ref" }, 404);
      if (!m[1]) return json([{ name: "b.txt", type: "file", size: 2 }, { name: "src", type: "dir", size: 0 }, { name: "a.bin", type: "file", size: 3 }]);
      if (m[1] === "/b.txt") return json({ size: 2, content: Buffer.from("hi").toString("base64") });
      if (m[1] === "/a.bin") return json({ size: 3, content: Buffer.from([1, 0, 2]).toString("base64") });
      return json({ message: "not found" }, 404);
    }
    if (p.startsWith("/commits/")) return json({ state: "success", total_count: 1, statuses: [] });
    if (url.pathname === "/api/v1/version") return json({ version: "16.0.6" });
    if (url.pathname === "/api/v1/user") return json({ login: "me" });
    if (url.pathname === "/api/v1/user/repos") return json([{ full_name: "me/proj", default_branch: "main", open_pr_counter: pulls.filter((x) => x.state === "open").length, updated_at: "2026-11-13T00:00:00Z" }, { full_name: "me/empty", empty: true }]);
    if (p === "/actions/tasks") return json({ workflow_runs: [{ status: "success", display_title: "ci", head_branch: "main", updated_at: "2026-11-13T00:00:00Z" }] });
    return json({ message: `no ${method} ${p}` }, 404);
  };
  return { forge, pulls, merged, comments };
}

const as = (f: ReturnType<typeof forgejo>, branch?: string): PrCall => ({ forge: f.forge, me: "assistant", branch, repo: "me/proj" });
const run = (name: string, a: object, c: PrCall) => PR_TOOLS[name].run(a, c) as Promise<any>;

describe("PR tools", () => {
  it("opens one PR per branch, updating it when opened again", async () => {
    const f = forgejo();
    const a = as(f, "agent/a/work");
    expect(await run("open_pr", { title: "one", body: "b" }, a)).toMatchObject({ number: 1, head: "agent/a/work", base: "main" });
    expect(await run("open_pr", { title: "one, again" }, a)).toMatchObject({ number: 1, title: "one, again" });
    expect(f.pulls).toHaveLength(1);
    expect(await run("list_prs", {}, a)).toHaveLength(1);
    await expect(run("open_pr", { title: "x" }, { forge: f.forge, me: "assistant" })).rejects.toThrow(/no repository/);
  });

  it("gives the Git tab each repository, its CI and its open PRs with their reviews", async () => {
    const f = forgejo();
    await run("open_pr", { title: "one" }, as(f, "agent/a/work"));
    await run("review_pr", { number: 1, verdict: "approve", body: "ok" }, as(f, "agent/b/work"));
    const o: any = await overview({ forge: f.forge, me: "user" });
    expect(o).toMatchObject({ version: "16.0.6", user: "me" });
    expect(o.repos).toEqual([expect.objectContaining({ name: "me/proj", prs: 1, ci: expect.objectContaining({ status: "success", title: "ci" }) })]);
    expect(o.prs).toEqual([expect.objectContaining({ repo: "me/proj", number: 1, checks: "success", review: { verdict: "approve", reviewer: "agent/b/work", current: true } })]);
  });

  it("merges only once another session has approved the head", async () => {
    const f = forgejo();
    const author = as(f, "agent/a/work");
    const other = as(f, "agent/b/work");
    await run("open_pr", { title: "one" }, author);
    await expect(run("merge_pr", { number: 1 }, author)).rejects.toThrow(/no review from another session/);
    await expect(run("review_pr", { number: 1, verdict: "approve", body: "lgtm" }, author)).rejects.toThrow(/your own branch/);
    await run("review_pr", { number: 1, verdict: "changes", body: "fix x" }, other);
    await expect(run("merge_pr", { number: 1 }, author)).rejects.toThrow(/asked for changes/);
    await run("review_pr", { number: 1, verdict: "approve", body: "good now" }, other);
    // A push after the approval needs another.
    f.pulls[0].head.sha = "b".repeat(40);
    await expect(run("merge_pr", { number: 1 }, author)).rejects.toThrow(/ask for another review/);
    await run("review_pr", { number: 1, verdict: "approve", body: "still good" }, as(f, "agent/c/work"));
    const read = await run("read_pr", { number: 1 }, author);
    expect(read.can_merge).toBe("yes");
    expect(read.reviews.map((r: any) => r.verdict)).toEqual(["changes", "approve", "approve"]);
    expect(read.diff).toContain("diff --git");
    expect(await run("merge_pr", { number: 1 }, author)).toMatchObject({ merged: true, into: "main" });
    expect(f.merged[0]).toEqual({ Do: "merge", delete_branch_after_merge: true, head_commit_id: "b".repeat(40) });
    await expect(run("merge_pr", { number: 1 }, author)).rejects.toThrow(/merged already/);
  });

  it("closes a PR without merging it, saying why on it", async () => {
    const f = forgejo();
    const c = as(f, "agent/a/work");
    await run("open_pr", { title: "one" }, c);
    await expect(run("close_pr", { number: 1, why: " " }, c)).rejects.toThrow(/say why/);
    expect(await run("close_pr", { number: 1, why: "#2 replaces it" }, c)).toMatchObject({ number: 1, state: "closed" });
    expect(f.comments).toEqual([{ number: 1, body: "#2 replaces it" }]);
    expect(f.merged).toEqual([]);
    await expect(run("close_pr", { number: 1, why: "again" }, c)).rejects.toThrow(/closed already/);
    await expect(run("merge_pr", { number: 1 }, c)).rejects.toThrow(/is closed/);
  });

  it("lists a branch's files, directories first, and reads one", async () => {
    const c = as(forgejo());
    expect(await contents(c, "me/proj", "main", "")).toEqual({ entries: [{ name: "src", dir: true, size: 0 }, { name: "a.bin", dir: false, size: 3 }, { name: "b.txt", dir: false, size: 2 }] });
    expect(await contents(c, "me/proj", "main", "b.txt")).toEqual({ file: { size: 2, binary: false, text: "hi", cut: false } });
    expect(await contents(c, "me/proj", "main", "a.bin")).toMatchObject({ file: { binary: true, text: undefined } });
    await expect(contents(c, "../x", "main", "")).rejects.toThrow(/owner\/repo/);
    await expect(contents(c, "me/..", "main", "")).rejects.toThrow(/owner\/repo/);
    await expect(contents(c, "me/proj", "main", "../../x")).rejects.toThrow(/no such path/);
  });

  it("reads a marker only from a review's last line", () => {
    expect(verdictOf({ body: "ok\n\ncorkboard-review: approve agent/b/work abcdef1" })).toMatchObject({ verdict: "approve", reviewer: "agent/b/work", body: "ok" });
    expect(verdictOf({ body: "corkboard-review: approve agent/b/work abcdef1\nbut then" })).toBeUndefined();
    // The PR's own branch's reviews don't count.
    const pr = { head: { ref: "agent/a/work", sha: "abcdef1234" } };
    expect(blocked(pr, [{ verdict: "approve", reviewer: "agent/a/work", sha: "abcdef1", at: "", body: "" }])).toMatch(/no review/);
  });
});

describe("the node's /mcp", () => {
  it("gives a session the PR tools, as its branch and repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prs-"));
    const oauth = new OAuthStore(join(dir, "oauth.json"));
    const f = forgejo();
    const none = { replicas: { get: () => undefined } } as any;
    const app = node({ data: none, search: none, oauth, origin: "http://127.0.0.1:1", toForge: f.forge });
    const token = oauth.mint("corkboard sessions", 1, "assistant");
    const rpc = (method: string, params: object) =>
      app(
        new Request("http://127.0.0.1:1/mcp?tools=forge", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Corkboard-Branch": "agent/a/work", "X-Corkboard-Repo": "me/proj" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        { requestIP: () => ({ address: "127.0.0.1" }) } as any,
      ).then((r) => r.json() as Promise<any>);
    const listed = await rpc("tools/list", {});
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(Object.keys(PR_TOOLS).sort());
    expect((await rpc("tools/call", { name: "list_boards", arguments: {} })).result.isError).toBe(true);
    const out = await rpc("tools/call", { name: "open_pr", arguments: { title: "one" } });
    expect(out.result.isError).toBeUndefined();
    expect(JSON.parse(out.result.content[0].text)).toMatchObject({ number: 1, head: "agent/a/work", base: "main" });
    rmSync(dir, { recursive: true });
  });
});
