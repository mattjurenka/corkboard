// Pull requests on the account's forge, for agents (.agent/plans/worktrees-prs.md):
// each session works on a branch of its own in a worktree, opens a PR from
// it, and merges it once another session has approved it.
//
// Every agent is the account's one Forgejo user, which can't approve its own
// PR and can't tell sessions apart, so the rule is kept here: a review is a
// COMMENT review whose body ends in a marker line,
//
//   corkboard-review: approve|changes <reviewer> <head sha>
//
// <reviewer> being the reviewing session's branch (or its agent's name
// when it has none), and merge_pr merges only when the newest marker from a
// reviewer other than the PR's own branch approves the PR's head as it is.
// The user merges as they like, on the forge's page or from review.lua.
//
// The caller's branch and repository come from its MCP config's
// X-Corkboard-Branch and X-Corkboard-Repo (corkboard.worktree's
// mcp_config); a call can name another repository.

import type { ToForge } from "./git";

// branch and repo: the caller's, owner/repo, when its session told them.
// user: the user's own call (review.lua's approve), which merges without a review.
export type PrCall = { forge: ToForge; me: string; branch?: string; repo?: string; user?: boolean };
export type PrTool = { description: string; properties?: Record<string, object>; required?: string[]; run: (a: any, c: PrCall) => Promise<unknown> };

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "integer", description });
const repoArg = str("owner/repo on the forge; leave it out for your session's own");

// A diff comes back up to this much; past it, read the files themselves.
const MAX_DIFF = 100 * 1024;
const MARKER = /^corkboard-review: (approve|changes) (\S+) ([0-9a-f]{7,64})\s*$/;
const REPO = /^(?!\.{1,2}\/)[\w.-]{1,100}\/(?!\.{1,2}$)[\w.-]{1,100}$/;

export type Verdict = { verdict: "approve" | "changes"; reviewer: string; sha: string; at: string; body: string };

// The marker a review's body ends in, if it has one.
export function verdictOf(r: { body?: string; submitted_at?: string }): Verdict | undefined {
  const lines = (r.body ?? "").trimEnd().split("\n");
  const m = lines[lines.length - 1]?.match(MARKER);
  if (!m) return;
  return { verdict: m[1] as Verdict["verdict"], reviewer: m[2], sha: m[3], at: r.submitted_at ?? "", body: lines.slice(0, -1).join("\n").trimEnd() };
}

// Why pr can't be merged on its reviews, or undefined when it can: the
// newest verdict from a reviewer other than its own branch approves its head.
export function blocked(pr: { head: { ref: string; sha: string } }, verdicts: Verdict[]): string | undefined {
  const others = verdicts.filter((v) => v.reviewer !== pr.head.ref);
  const last = others[others.length - 1];
  if (!last) return "it has no review from another session yet; ask one for it (review_pr), or the user to merge it";
  if (last.verdict !== "approve") return `${last.reviewer} asked for changes; push them and ask for another review`;
  if (!pr.head.sha.startsWith(last.sha)) return `${last.reviewer} approved ${last.sha.slice(0, 10)}, but the branch is at ${pr.head.sha.slice(0, 10)} now; ask for another review`;
}

function repoOf(a: any, c: PrCall): string {
  const repo = String(a.repo ?? c.repo ?? "");
  if (!repo) throw new Error("your session has no repository on the forge; pass repo as owner/repo");
  if (!REPO.test(repo)) throw new Error(`repo is owner/repo, not ${repo}`);
  return repo;
}

function number(a: any): number {
  const n = Number(a.number);
  if (!Number.isInteger(n) || n < 1) throw new Error("number is the pull request's number, from list_prs");
  return n;
}

async function api<T = any>(c: PrCall, path: string, init: RequestInit = {}): Promise<T> {
  const res = await c.forge(`/api/v1${path}`, { ...init, headers: { accept: "application/json", ...(init.body !== undefined && { "content-type": "application/json" }), ...init.headers } });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {}
    throw new Error(`the forge answered ${res.status}${message ? `: ${message}` : ""}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = (c: PrCall, path: string, body: unknown) => api(c, path, { method: "POST", body: JSON.stringify(body) });

const brief = (p: any) => ({
  number: p.number,
  title: p.title,
  head: p.head?.ref,
  base: p.base?.ref,
  state: p.merged ? "merged" : p.state,
  mergeable: p.mergeable,
  url: p.html_url,
  updated: p.updated_at,
});

async function verdicts(c: PrCall, repo: string, n: number): Promise<Verdict[]> {
  const reviews = await api<any[]>(c, `/repos/${repo}/pulls/${n}/reviews?limit=50`);
  return reviews.map(verdictOf).filter((v): v is Verdict => !!v).sort((x, y) => x.at.localeCompare(y.at));
}

export const PR_TOOLS: Record<string, PrTool> = {
  open_pr: {
    description:
      "Open a pull request on the forge from your branch (commit and git push it to origin first), into the repository's default branch unless you say. If one is open from your branch already, you get that one, with title and body updated. Another session reviews it (review_pr) before you can merge it (merge_pr).",
    properties: { title: str("What it does, in a line"), body: str("What changed and why, and how you checked it"), base: str("The branch to merge into; the default branch if left out"), head: str("The branch to merge; your session's if left out"), repo: repoArg },
    required: ["title"],
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const head = String(a.head ?? c.branch ?? "");
      if (!head) throw new Error("your session has no branch; pass head");
      const base = String(a.base ?? (await api(c, `/repos/${repo}`)).default_branch);
      const open = (await api<any[]>(c, `/repos/${repo}/pulls?state=open&limit=50`)).find((p) => p.head?.ref === head && p.base?.ref === base);
      const fields = { title: String(a.title), ...(a.body !== undefined && { body: String(a.body) }) };
      if (open) return brief(await api(c, `/repos/${repo}/pulls/${open.number}`, { method: "PATCH", body: JSON.stringify(fields) }));
      return brief(await post(c, `/repos/${repo}/pulls`, { ...fields, head, base }));
    },
  },
  list_prs: {
    description: "List the repository's pull requests, open ones unless you ask for closed or all, newest first.",
    properties: { state: { type: "string", enum: ["open", "closed", "all"], description: "Which; open if left out" }, repo: repoArg },
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const state = ["open", "closed", "all"].includes(a.state) ? a.state : "open";
      return (await api<any[]>(c, `/repos/${repo}/pulls?state=${state}&sort=recentupdate&limit=50`)).map(brief);
    },
  },
  read_pr: {
    description: "Read a pull request: what it says, its reviews, its checks and its diff (up to 100 KB; past that, read the files on its branch).",
    properties: { number: num("Its number, from list_prs"), repo: repoArg },
    required: ["number"],
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const n = number(a);
      const pr = await api(c, `/repos/${repo}/pulls/${n}`);
      const [reviews, status, diff] = await Promise.all([
        verdicts(c, repo, n),
        api(c, `/repos/${repo}/commits/${pr.head.sha}/status`).catch(() => undefined),
        c.forge(`/api/v1/repos/${repo}/pulls/${n}.diff`).then((r) => (r.ok ? r.text() : "")),
      ]);
      return {
        ...brief(pr),
        sha: pr.head.sha,
        body: pr.body,
        reviews,
        can_merge: pr.merged ? "merged already" : !pr.mergeable ? "it doesn't merge cleanly; merge the base into the branch and push" : (blocked(pr, reviews) ?? "yes"),
        checks: status && { state: status.state, each: (status.statuses ?? []).map((s: any) => ({ context: s.context, state: s.status ?? s.state, description: s.description })) },
        diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… cut at 100 KB of ${diff.length} bytes` : diff,
      };
    },
  },
  review_pr: {
    description:
      "Review another session's pull request, once you've read it (read_pr) and checked it: approve, or ask for changes, saying why. An approval is of the PR's head as it is now; a push after it needs another. You can't review a PR from your own branch.",
    properties: { number: num("Its number, from list_prs"), verdict: { type: "string", enum: ["approve", "changes"], description: "approve, or changes to ask for them" }, body: str("What you found, and what to change if anything"), repo: repoArg },
    required: ["number", "verdict", "body"],
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const n = number(a);
      if (a.verdict !== "approve" && a.verdict !== "changes") throw new Error("verdict is approve or changes");
      const reviewer = (c.branch ?? c.me).replace(/\s+/g, "-");
      const pr = await api(c, `/repos/${repo}/pulls/${n}`);
      if (pr.head.ref === reviewer) throw new Error("this is your own branch's pull request; another session reviews it");
      const body = `${String(a.body).trimEnd()}\n\ncorkboard-review: ${a.verdict} ${reviewer} ${pr.head.sha}`;
      await post(c, `/repos/${repo}/pulls/${n}/reviews`, { event: "COMMENT", body, commit_id: pr.head.sha });
      return { number: n, verdict: a.verdict, reviewer, sha: pr.head.sha };
    },
  },
  merge_pr: {
    description:
      "Merge a pull request once another session has approved its head (review_pr), and delete its branch. Then remove your worktree if it was yours, and stop working on that branch.",
    properties: { number: num("Its number, from list_prs"), repo: repoArg },
    required: ["number"],
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const n = number(a);
      const pr = await api(c, `/repos/${repo}/pulls/${n}`);
      if (pr.merged) throw new Error(`#${n} is merged already`);
      if (pr.state !== "open") throw new Error(`#${n} is closed`);
      if (!pr.mergeable) throw new Error(`#${n} doesn't merge cleanly; merge ${pr.base.ref} into ${pr.head.ref}, push, and ask for another review`);
      const why = !c.user && blocked(pr, await verdicts(c, repo, n));
      if (why) throw new Error(`#${n} can't be merged yet: ${why}`);
      await post(c, `/repos/${repo}/pulls/${n}/merge`, { Do: "merge", delete_branch_after_merge: true, head_commit_id: pr.head.sha });
      return { number: n, merged: true, into: pr.base.ref, sha: pr.head.sha };
    },
  },
  close_pr: {
    description:
      "Close a pull request without merging it, saying why on it: one of your own a later one replaces, or one the user asked you to close. Its branch stays, so it can be opened again.",
    properties: { number: num("Its number, from list_prs"), why: str("Why it's closed, left on it as a comment"), repo: repoArg },
    required: ["number", "why"],
    run: async (a, c) => {
      const repo = repoOf(a, c);
      const n = number(a);
      const why = String(a.why ?? "").trim();
      if (!why) throw new Error("say why it's closed");
      const pr = await api(c, `/repos/${repo}/pulls/${n}`);
      if (pr.merged) throw new Error(`#${n} is merged already`);
      if (pr.state !== "open") throw new Error(`#${n} is closed already`);
      await post(c, `/repos/${repo}/issues/${n}/comments`, { body: why });
      return brief(await api(c, `/repos/${repo}/pulls/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }));
    },
  },
};

// The Git tab's forge (nvim corkboard.git): who and what it is, how long it
// took to answer, each repository with its last CI run, and every open PR
// with its checks and the newest verdict from another session.
export async function overview(c: PrCall) {
  const t0 = performance.now();
  const [version, user, repos] = await Promise.all([api(c, "/version"), api(c, "/user"), api<any[]>(c, "/user/repos?limit=50")]);
  const ms = Math.round(performance.now() - t0);
  const live = repos.filter((r) => !r.empty).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const each = await Promise.all(
    live.map(async (r) => {
      const name = r.full_name as string;
      const [tasks, pulls] = await Promise.all([
        api(c, `/repos/${name}/actions/tasks?limit=1`).catch(() => undefined),
        r.open_pr_counter > 0 ? api<any[]>(c, `/repos/${name}/pulls?state=open&sort=recentupdate&limit=50`).catch(() => []) : [],
      ]);
      const t = tasks?.workflow_runs?.[0];
      const prs = await Promise.all(
        pulls.map(async (p) => {
          const [vs, status] = await Promise.all([verdicts(c, name, p.number).catch(() => []), api(c, `/repos/${name}/commits/${p.head.sha}/status`).catch(() => undefined)]);
          const last = vs.filter((v) => v.reviewer !== p.head.ref).pop();
          return {
            ...brief(p),
            repo: name,
            sha: p.head.sha,
            checks: status?.total_count ? status.state : null,
            review: last ? { verdict: last.verdict, reviewer: last.reviewer, current: p.head.sha.startsWith(last.sha) } : null,
          };
        }),
      );
      return {
        repo: { name, default: r.default_branch, url: r.html_url, prs: r.open_pr_counter ?? 0, updated: r.updated_at, ci: t ? { status: t.status, title: t.display_title ?? t.name, branch: t.head_branch, at: t.updated_at } : null },
        prs,
      };
    }),
  );
  return { version: version.version, ms, user: user.login, repos: each.map((e) => e.repo), prs: each.flatMap((e) => e.prs) };
}

// A file preview comes back up to this much.
const MAX_FILE = 256 * 1024;

// What's at path in repo on ref, for the Git tab's files: a directory's
// entries, directories first, or a file's text (none for a binary one).
export async function contents(c: PrCall, repo: string, ref: string, path: string) {
  if (!REPO.test(repo)) throw new Error(`repo is owner/repo, not ${repo}`);
  const parts = path ? path.split("/") : [];
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`no such path ${path}`);
  const at = parts.map((p) => `/${encodeURIComponent(p)}`).join("");
  const r = await api(c, `/repos/${repo}/contents${at}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(r)) {
    const entries = r.map((e: any) => ({ name: e.name as string, dir: e.type === "dir", size: (e.size ?? 0) as number }));
    return { entries: entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) };
  }
  const bytes = Buffer.from(r.content ?? "", "base64");
  const binary = bytes.includes(0);
  return { file: { size: r.size as number, binary, text: binary ? undefined : bytes.subarray(0, MAX_FILE).toString("utf8"), cut: !binary && bytes.length > MAX_FILE } };
}
