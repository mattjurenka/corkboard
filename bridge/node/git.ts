// The account's repositories on its forge, for the portal's file browser
// and the page's own Neovim (web/src/nvim/wasm): /api/node/git/..., as the
// hosted Worker's /api/git was, read from the forge wherever it runs
// (serve.ts's toForge) as the account's Forgejo user. Through the tunnel
// only while the account has the forge's pages on (server.ts).
//
//   GET  git                                { origin }: where the forge's pages are
//   GET  git/repos                          the user's repositories
//   GET  git/repos/:owner/:repo             the repository, with its branches
//   GET  git/repos/:owner/:repo/branches    its branches, newest first: each one's last commit,
//                                           and how far it is ahead of and behind the default
//   GET  git/repos/:owner/:repo/contents/:path?ref=
//                                           a directory's entries, or a file and its content
//   GET  git/repos/:owner/:repo/info/refs?service=git-upload-pack
//   POST git/repos/:owner/:repo/git-upload-pack
//                                           git's smart HTTP, for a clone or fetch
//
// Read-only: nothing here writes.

export type ToForge = (path: string, init?: RequestInit) => Promise<Response>;

// A file's content comes back only up to this; past it, the page links to Forgejo.
const MAX_FILE = 1024 * 1024;
const NAME = /^[\w.-]{1,100}$/;
const REF = /^[\w./-]{1,200}$/;
// How many branches get ahead/behind counts: two requests each.
const COMPARED = 20;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

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
  const b64 = f.content.replace(/\s/g, "");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64"));
    if (text.includes("\0")) throw new Error("binary");
    return { ...base, content: text, binary: false, too_large: false };
  } catch {
    return { ...base, content: b64, binary: true, too_large: false };
  }
}

export function gitViews(toForge: ToForge) {
  const api = (path: string) => toForge(`/api/v1${path}`, { headers: { accept: "application/json" } });
  // Forgejo's answer, cut to what the page shows, or its error as ours.
  const relay = async <T>(res: Response, shape: (body: any) => T) => {
    const body = await res.json().catch(() => null);
    if (!res.ok) return error(res.status === 401 || res.status === 403 ? 502 : res.status, body?.message ?? body?.error ?? `forgejo: HTTP ${res.status}`);
    return json(shape(body));
  };

  async function branchList(at: string): Promise<Response> {
    const [r, b] = await Promise.all([api(at), api(`${at}/branches?limit=50`)]);
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
      const res = await api(`${at}/compare/${from}...${to}`);
      return res.ok ? (((await res.json()) as any).total_commits as number) : null;
    };
    if (base)
      await Promise.all(
        list
          .filter((x) => !x.default)
          .slice(0, COMPARED)
          .map(async (x) => void ([x.ahead, x.behind] = await Promise.all([count(base, x.sha), count(x.sha, base)]))),
      );
    return json(list);
  }

  // git's smart HTTP, upload-pack only, its bodies passed as they are.
  async function smart(req: Request, url: URL, owner: string, name: string, what: string): Promise<Response> {
    const refs = what === "info";
    if (req.method !== (refs ? "GET" : "POST")) return error(405, "method not allowed");
    if (refs && url.searchParams.get("service") !== "git-upload-pack") return error(403, "only git-upload-pack");
    const headers = new Headers();
    for (const h of ["content-type", "accept", "git-protocol", "content-encoding"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    const res = await toForge(`/${owner}/${name}.git/${refs ? "info/refs?service=git-upload-pack" : "git-upload-pack"}`, { method: req.method, headers, ...(!refs && { body: req.body }), signal: req.signal });
    const out = new Headers({ "cache-control": "no-store" });
    const type = res.headers.get("content-type");
    if (type) out.set("content-type", type);
    return new Response(res.body, { status: res.status, headers: out });
  }

  // path: what follows git/, decoded.
  return async function git(req: Request, path: string[]): Promise<Response> {
    const url = new URL(req.url);
    const [repos, owner, rawName, sub, ...rest] = path;
    const name = rawName?.replace(/\.git$/, "");
    if (repos === "repos" && owner && name && (sub === "git-upload-pack" || (sub === "info" && rest.join("/") === "refs"))) {
      if (!NAME.test(owner) || !NAME.test(name)) return error(400, "bad repository name");
      return smart(req, url, owner, name, sub === "info" ? "info" : "pack");
    }
    if (req.method !== "GET") return error(405, "method not allowed");
    if (!repos) {
      // The forge's own address, from where it says the user's page is.
      const res = await api("/user");
      if (!res.ok) return relay(res, () => null);
      const u = (await res.json()) as any;
      return json({ origin: new URL(String(u.html_url)).origin });
    }
    if (repos !== "repos") return error(404, "not found");
    if (!owner) return relay(await api("/user/repos?limit=50"), (rs: any[]) => rs.map(repo).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")));
    if (!name || !NAME.test(owner) || !NAME.test(name)) return error(400, "bad repository name");
    const at = `/repos/${owner}/${name}`;
    if (sub === "branches" && !rest.length) return branchList(at);
    if (!sub) {
      const [r, b] = await Promise.all([api(at), api(`${at}/branches?limit=50`)]);
      if (!b.ok) return relay(b, () => null);
      const branches = ((await b.json()) as any[]).map((x) => x.name as string);
      return relay(r, (body) => ({ ...repo(body), branches }));
    }
    if (sub !== "contents") return error(404, "not found");
    if (rest.some((s) => s === "." || s === ".." || !s || s.includes("/"))) return error(400, "bad path");
    const ref = url.searchParams.get("ref");
    if (ref !== null && !REF.test(ref)) return error(400, "bad ref");
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await api(`${at}/contents${rest.length ? "/" + rest.map(encodeURIComponent).join("/") : ""}${q}`);
    return relay(res, (body) =>
      Array.isArray(body)
        ? {
            type: "dir",
            path: rest.join("/"),
            entries: body
              .map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
              .sort((a: any, b: any) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name)),
          }
        : file(body),
    );
  };
}
