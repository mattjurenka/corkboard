// What's between a client and Forgejo, wherever the account is checked:
// whether a grant's scope lets a request through (its repos, permissions
// and refs), and the request forwarded as the account's Forgejo user, in
// the header Forgejo trusts for reverse-proxy sign-in. The hosted gate
// (gate.ts) uses it after a cbg_ session; the node (bridge/node/forge.ts)
// after a sealed channel's peer.

import { type Level, type Permission, type Scope, atLeast, refAllowed, repoAllowed } from "../../lib/e2ee/forge";
import { PushError, isDelete, readCommands } from "./push";
import { type Need, OPEN_API, apiRule, gitRoute } from "./routes";

export type Upstream = {
  // Forgejo: its base URL, and a unix socket to reach it on, if it listens on one.
  upstream: string;
  unix?: string;
  // The header Forgejo's REVERSE_PROXY_AUTHENTICATION_USER names.
  userHeader: string;
};

// An API write's body, held to read its refs.
const MAX_BODY = 64 * 1024 * 1024;

export const HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"];

export type Verdict = { ok: true; body?: BodyInit | null; dropEncoding?: boolean } | { ok: false; status: number; error: string };
const no = (status: number, e: string): Verdict => ({ ok: false, status, error: e });

export function forgeProxy(config: Upstream) {
  const upstream = (path: string, init: RequestInit & { headers: Headers }) => {
    init.headers.set("accept-encoding", "identity");
    return fetch(new URL(path, config.upstream), { ...init, redirect: "manual", ...(config.unix && { unix: config.unix }), ...(init.body && { duplex: "half" }) } as RequestInit);
  };

  // url: the request's, as Forgejo would see it (its path Forgejo's).
  async function allow(req: Request, url: URL, user: string, scope: Scope): Promise<Verdict> {
    const method = req.method;
    const raw = url.pathname;
    if (/%2f|%5c|\/\.\.?(\/|$)|\/\//i.test(raw)) return no(400, "not a path a grant takes");
    if (OPEN_API.has(`${method} ${raw}`)) return { ok: true, body: req.body };

    const git = gitRoute(method, raw, url.searchParams.get("service"));
    if (git) {
      if (!repoAllowed(scope, git.owner, git.repo)) return no(403, `the grant doesn't cover ${git.owner}/${git.repo}`);
      const perm: Permission = git.wiki ? "wiki" : "contents";
      const level: Level = git.push ? "write" : "read";
      if (!atLeast(scope, perm, level)) return no(403, `the grant doesn't give ${perm}:${level}`);
      if (!git.push || git.advertise || !req.body) return { ok: true, body: req.body };
      let stream = req.body as ReadableStream<Uint8Array>;
      const enc = req.headers.get("content-encoding");
      if (enc === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip") as any);
      else if (enc && enc !== "identity") return no(415, `content-encoding ${enc}`);
      try {
        const { commands, body } = await readCommands(stream);
        if (!git.wiki) for (const c of commands) if (!refAllowed(scope, c.ref)) return no(403, `the grant doesn't let it ${isDelete(c) ? "delete" : "push"} ${c.ref}`);
        return { ok: true, body, dropEncoding: !!enc && enc !== "identity" };
      } catch (e) {
        if (e instanceof PushError) return no(400, e.message);
        throw e;
      }
    }

    const m = raw.match(/^\/api\/v1\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/);
    if (!m) return no(403, "a grant reaches a repository's API and git, and nothing else");
    const [, owner, repo, restRaw = ""] = m;
    if (!repoAllowed(scope, owner, repo)) return no(403, `the grant doesn't cover ${owner}/${repo}`);
    let rest: string;
    try {
      rest = decodeURIComponent(restRaw);
    } catch {
      return no(400, "not a path a grant takes");
    }
    const found = apiRule(method, rest);
    if (!found) return no(403, `a grant can't ${method} ${rest || "/"}`);
    const { rule, params } = found;

    const base = `/api/v1/repos/${owner}/${repo}`;
    const get = async (p: string) => {
      const res = await upstream(base + p, { headers: new Headers({ [config.userHeader]: user, accept: "application/json" }) });
      return res.ok ? res.json() : null;
    };

    let needs: Need[] = rule.needs;
    if (rule.issue) {
      const isPull = rule.issue === "n" ? !!(await get(`/issues/${params.n}`))?.pull_request : !!(await get(`/issues/comments/${params.c}`))?.pull_request_url;
      if (isPull) needs = needs.map((n) => (n.perm === "issues" ? { ...n, perm: "pull_requests" as const } : n));
    }
    for (const n of needs) if (!atLeast(scope, n.perm, n.level)) return no(403, `the grant doesn't give ${n.perm}:${n.level}`);
    if (rule.del && !scope.del) return no(403, "the grant doesn't let it delete or give away the repository");

    let forward: BodyInit | null = req.body;
    if (scope.refs !== null && rule.refs) {
      let parsed: any = null;
      if (rule.body && req.body) {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_BODY) return no(413, "too large");
        forward = bytes;
        try {
          parsed = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        } catch {
          parsed = null;
        }
      }
      const refs = await rule.refs({ params, body: parsed, get });
      for (const ref of refs) if (!refAllowed(scope, ref)) return no(403, `the grant doesn't let it move ${ref}`);
    }
    return { ok: true, body: forward };
  }

  // url: as allow's. user: who it goes as, or null to go as it came (for
  // Forgejo's own sign-in and tokens); either way the user header is only ours.
  async function forward(req: Request, url: URL, user: string | null, body: BodyInit | null | undefined, dropEncoding = false): Promise<Response> {
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP.includes(k)) headers.set(k, v);
    });
    headers.delete(config.userHeader);
    headers.delete("x-corkboard-chain");
    if (user) {
      headers.set(config.userHeader, user);
      headers.delete("authorization");
      headers.delete("cookie");
    }
    if (dropEncoding) headers.delete("content-encoding");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await upstream(url.pathname + url.search, { method: req.method, headers, body: hasBody ? (body ?? null) : undefined });
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!HOP.includes(k) && k !== "content-encoding") out.append(k, v);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  return { upstream, allow, forward };
}
