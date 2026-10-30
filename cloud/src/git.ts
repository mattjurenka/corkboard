// The user's repositories on Forgejo (git.corkboard.fyi), for the portal's
// file browser (../portal). The Worker reads them with FORGEJO_TOKEN, a
// Forgejo access token of the user's with read:repository and read:user
// only, kept as a secret: the page asks with its own corkboard token and
// never sees Forgejo's. This Worker lets one Google account in
// (ALLOWED_EMAIL), so one token is enough.
//
//   GET  /api/git                                { origin }
//   GET  /api/git/repos                          the user's repositories
//   GET  /api/git/repos/:owner/:repo             the repository, with its branches
//   GET  /api/git/repos/:owner/:repo/branches    its branches, newest first: each one's last commit,
//                                                and how far it is ahead of and behind the default
//   GET  /api/git/repos/:owner/:repo/contents/:path?ref=
//                                                a directory's entries, or a file and its content
//
// Read-only: no route here writes, and the token couldn't. Owner tokens only (api.ts).

import type { Env } from "./index";

// A file's content comes back only up to this; past it, the page links to Forgejo.
const MAX_FILE = 1024 * 1024;

const NAME = /^[\w.-]{1,100}$/;
const REF = /^[\w./-]{1,200}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

async function forgejo(env: Env, path: string): Promise<Response> {
  return fetch(`${env.FORGEJO_ORIGIN}/api/v1${path}`, { headers: { Authorization: `token ${env.FORGEJO_TOKEN}`, Accept: "application/json" } });
}

// Forgejo's answer, cut to what the page shows, or its error as ours. Its
// 401 or 403 is the token's problem, not the caller's.
async function relay<T>(res: Response, shape: (body: any) => T): Promise<Response> {
  const body = await res.json().catch(() => null);
  if (!res.ok) return error(res.status === 401 || res.status === 403 ? 502 : res.status, (body as any)?.message ?? `forgejo: HTTP ${res.status}`);
  return json(shape(body));
}

const repo = (r: any) => ({
  owner: r.owner?.login,
  name: r.name,
  description: r.description || null,
  private: !!r.private,
  default_branch: r.default_branch,
  updated: r.updated_at,
  empty: !!r.empty,
  url: r.html_url,
});

// Text, when it decodes as UTF-8 with no NULs; otherwise the page says binary.
function file(f: any) {
  const base = { type: "file" as const, name: f.name, path: f.path, size: f.size, url: f.html_url };
  if (f.size > MAX_FILE || typeof f.content !== "string") return { ...base, content: null, binary: false, too_large: f.size > MAX_FILE };
  const bytes = Uint8Array.from(atob(f.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (text.includes("\0")) throw new Error("binary");
    return { ...base, content: text, binary: false, too_large: false };
  } catch {
    return { ...base, content: f.content.replace(/\s/g, ""), binary: true, too_large: false };
  }
}

// How many branches get ahead/behind counts: two requests each, under the
// Worker's subrequest limit with room to spare.
const COMPARED = 20;

// The branches, newest commit first, each with that commit and, for the
// newest COMPARED, how many commits it is ahead of and behind the default
// branch (compared by commit, so a name with a slash needs no escaping).
async function branchList(env: Env, at: string): Promise<Response> {
  const [r, b] = await Promise.all([forgejo(env, at), forgejo(env, `${at}/branches?limit=50`)]);
  if (!r.ok) return relay(r, () => null);
  if (!b.ok) return relay(b, () => null);
  const main = ((await r.json()) as any).default_branch as string;
  const list = ((await b.json()) as any[])
    .map((x) => ({
      name: x.name as string,
      sha: x.commit?.id as string,
      message: String(x.commit?.message ?? "").split("\n")[0],
      author: (x.commit?.author?.name ?? null) as string | null,
      date: (x.commit?.timestamp ?? null) as string | null,
      default: x.name === main,
      ahead: null as number | null,
      behind: null as number | null,
    }))
    .sort((a, b) => Number(b.default) - Number(a.default) || Date.parse(b.date ?? "0") - Date.parse(a.date ?? "0"));
  const base = list.find((x) => x.default)?.sha;
  const count = async (from: string, to: string) => {
    const res = await forgejo(env, `${at}/compare/${from}...${to}`);
    return res.ok ? (((await res.json()) as any).total_commits as number) : null;
  };
  if (base)
    await Promise.all(
      list
        .filter((x) => !x.default)
        .slice(0, COMPARED)
        .map(async (x) => {
          [x.ahead, x.behind] = await Promise.all([count(base, x.sha), count(x.sha, base)]);
        }),
    );
  return json(list);
}

export async function gitRoutes(request: Request, env: Env): Promise<Response> {
  if (!env.FORGEJO_ORIGIN || !env.FORGEJO_TOKEN) return error(404, "no Forgejo is set up");
  if (request.method !== "GET") return error(405, "method not allowed");
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/git") return json({ origin: env.FORGEJO_ORIGIN });
  if (path === "/api/git/repos") {
    const res = await forgejo(env, "/user/repos?limit=50");
    return relay(res, (rs: any[]) => rs.map(repo).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")));
  }
  const m = path.match(/^\/api\/git\/repos\/([^/]+)\/([^/]+)(?:\/(branches)|\/contents(?:\/(.*))?)?$/);
  if (!m) return error(404, "not found");
  const [, owner, name, branches, rest] = m;
  if (!NAME.test(owner) || !NAME.test(name)) return error(400, "bad repository name");
  const at = `/repos/${owner}/${name}`;
  if (branches) return branchList(env, at);
  if (!path.includes("/contents")) {
    const [r, b] = await Promise.all([forgejo(env, at), forgejo(env, `${at}/branches?limit=50`)]);
    if (!b.ok) return relay(b, () => null);
    const branches = ((await b.json()) as any[]).map((x) => x.name as string);
    return relay(r, (body) => ({ ...repo(body), branches }));
  }
  const segments = rest ? decodeURIComponent(rest).split("/").filter(Boolean) : [];
  if (segments.some((s) => s === "." || s === "..")) return error(400, "bad path");
  const ref = url.searchParams.get("ref");
  if (ref !== null && !REF.test(ref)) return error(400, "bad ref");
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await forgejo(env, `${at}/contents${segments.length ? "/" + segments.map(encodeURIComponent).join("/") : ""}${q}`);
  return relay(res, (body) =>
    Array.isArray(body)
      ? {
          type: "dir",
          path: segments.join("/"),
          entries: body
            .map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
            .sort((a: any, b: any) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name)),
        }
      : file(body),
  );
}
