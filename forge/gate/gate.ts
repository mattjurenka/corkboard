// The forge gate (.agent/plans/forge-keys.md): in front of Forgejo, it
// lets an account's devices in as the account's Forgejo user, and the keys
// they grant to only what their grants allow (lib/e2ee/forge.ts, routes.ts).
//
//   GET  /gate/challenge   { nonce }, for one session, within NONCE_MS
//   POST /gate/session     { account, chain: { cert, grants? }, answer } → { token, expires, user }
//   GET  /gate/session     what this request's token may do
//   POST /gate/bind        { view, bind, cert?, ssh? | forgejo_token? }: the account's binding
//                          to a user, signed by the account's key or by a device (its cert
//                          with it), shown to be the user's by signatures from SSH keys
//                          Forgejo has for them, or a token of theirs (checked, never kept)
//   POST /gate/account     { view }: the account's key moved on (its rotations)
//   POST /gate/revoke      { account, revocation? , grant? }: a device, or a grant, taken back
//
// Everything else goes to Forgejo. With a session's token (Bearer cbg_…, or
// as Basic's password, for git) it goes as the account's user in the
// header Forgejo trusts for reverse-proxy sign-in, which the gate takes off
// every request it doesn't set it on. Without one it goes as it came, for
// Forgejo's own sign-in and tokens.

import {
  type Chain,
  type Checked,
  type ForgeBind,
  type ForgeChallenge,
  type GrantRevocation,
  type Level,
  type Permission,
  type Scope,
  atLeast,
  checkAnswer,
  checkBind,
  checkChain,
  checkGrantRevocation,
  FORGE_BIND_SSH,
  forgeBindBytes,
  refAllowed,
  repoAllowed,
} from "../../lib/e2ee/forge";
import { currentKey } from "../../lib/e2ee/sharing";
import { checkCert, verify } from "../../lib/e2ee/device";
import { sshSigned } from "./ssh";
import { type AccountView, type DeviceCert, type Revocation, type Signed, KEY, b64url, isRevocation, revocationBytes } from "../../lib/e2ee/wire";
import { PushError, isDelete, readCommands } from "./push";
import { type Need, type Rule, OPEN_API, apiRule, gitRoute } from "./routes";
import type { Store } from "./store";

export type GateConfig = {
  // The gate's own origin, which bindings and answers name.
  origin: string;
  // Forgejo: its base URL, and a unix socket to reach it on, if it listens on one.
  upstream: string;
  unix?: string;
  // The header Forgejo's REVERSE_PROXY_AUTHENTICATION_USER names.
  userHeader: string;
  // Pages that may call the gate from a browser.
  corsOrigins: string[];
  store: Store;
  now?: () => number;
};

const TOKEN = "cbg_";
const NONCE_MS = 2 * 60_000;
const SESSION_MS = 3600_000;
const MAX_NONCES = 10_000;
// An API write's body, held to read its refs.
const MAX_BODY = 64 * 1024 * 1024;

type Session = { account: string; user: string; checked: Checked; expires: number };

const HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

async function body(req: Request): Promise<Record<string, any>> {
  try {
    const v = await req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return {};
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// The rotations of a view are the stored one's and maybe more: a view
// from before a rotation can't take the key back.
const extends_ = (now: AccountView, before: AccountView) => {
  const a = before.proof.rotations ?? [];
  const b = now.proof.rotations ?? [];
  return b.length >= a.length && a.every((r, i) => r.sig === b[i]?.sig);
};

export function createGate(config: GateConfig) {
  const { store } = config;
  const now = config.now ?? Date.now;
  const nonces = new Map<string, number>();
  const sessions = new Map<string, Session>();

  const upstream = (path: string, init: RequestInit & { headers: Headers }) => {
    init.headers.set("accept-encoding", "identity");
    return fetch(new URL(path, config.upstream), { ...init, redirect: "manual", ...(config.unix && { unix: config.unix }), ...(init.body && { duplex: "half" }) } as RequestInit);
  };

  const cors = (req: Request, res: Response) => {
    const o = req.headers.get("origin");
    if (!o || !config.corsOrigins.includes(o)) return res;
    const headers = new Headers(res.headers);
    headers.set("access-control-allow-origin", o);
    headers.append("vary", "origin");
    headers.set("access-control-expose-headers", "content-type");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  function revokedFor(id: string, key: string) {
    return {
      devices: store.revocations(id),
      grant: (hash: string, issuer: string) => store.grantRevokedBy(hash).some((by) => by === issuer || by === key),
    };
  }

  // Sessions a revocation or a rotation ends.
  function drop(test: (s: Session) => boolean) {
    for (const [t, s] of sessions) if (test(s)) sessions.delete(t);
  }

  function sessionOf(req: Request): Session | null | "none" {
    const auth = req.headers.get("authorization") ?? "";
    let token: string | undefined;
    if (auth.startsWith(`Bearer ${TOKEN}`)) token = auth.slice(7);
    else if (auth.startsWith("Basic ")) {
      try {
        const pass = atob(auth.slice(6)).split(":").slice(1).join(":");
        if (pass.startsWith(TOKEN)) token = pass;
      } catch {}
    }
    if (!token) return "none";
    const s = sessions.get(token);
    if (!s || s.expires <= now()) {
      sessions.delete(token);
      return null;
    }
    return s;
  }

  // The gate's own routes ------------------------------------------------------

  async function session(req: Request): Promise<Response> {
    const { account, chain, answer } = (await body(req)) as { account: string; chain: Chain; answer: Signed<ForgeChallenge> };
    if (typeof account !== "string" || !KEY.test(account)) return error(400, "account is the account's id");
    const b = store.binding(account);
    if (!b) return error(403, "this account isn't bound to a user here");
    const checked = checkChain(account, b.key, chain, revokedFor(account, b.key), now());
    if (typeof checked === "string") return error(403, checked);
    const nonce = answer?.body?.nonce;
    const until = typeof nonce === "string" ? nonces.get(nonce) : undefined;
    if (!until || until <= now()) return error(403, "no such challenge, or it's past");
    const bad = checkAnswer(answer, config.origin, nonce, checked.holder);
    if (bad) return error(403, bad);
    nonces.delete(nonce);
    const expires = Math.min(now() + SESSION_MS, checked.scope?.expires ?? Infinity);
    const token = TOKEN + random(32);
    sessions.set(token, { account, user: b.user, checked, expires });
    return json({ token, expires, user: b.user, scope: checked.scope }, 201);
  }

  // The user's login, if one of the signatures is by an SSH key Forgejo has
  // for them (asked as them, which the gate may).
  async function bySsh(user: string, bytes: Uint8Array, sigs: unknown): Promise<string | null> {
    if (!Array.isArray(sigs) || !sigs.length || sigs.length > 8 || !sigs.every((x) => typeof x === "string" && x.length < 4096)) return null;
    const res = await upstream("/api/v1/user/keys", { headers: new Headers({ [config.userHeader]: user, accept: "application/json" }) });
    const keys = (await res.json().catch(() => null)) as { key?: string }[] | null;
    if (!res.ok || !Array.isArray(keys)) return null;
    const lines = keys.map((k) => k.key).filter((k): k is string => typeof k === "string");
    for (const sig of sigs) if (await sshSigned(lines, FORGE_BIND_SSH, bytes, sig)) return user;
    return null;
  }

  async function byToken(token: unknown): Promise<string | null> {
    if (typeof token !== "string" || !token) return null;
    const res = await upstream("/api/v1/user", { headers: new Headers({ authorization: `token ${token}`, accept: "application/json" }) });
    const me = (await res.json().catch(() => null)) as { login?: string } | null;
    return res.ok && me?.login ? me.login : null;
  }

  async function bind(req: Request): Promise<Response> {
    const { view, bind, cert, ssh, forgejo_token } = (await body(req)) as { view: AccountView; bind: Signed<ForgeBind>; cert?: Signed<DeviceCert>; ssh?: string[]; forgejo_token?: string };
    const bad = checkBind(bind, config.origin);
    if (bad) return error(400, bad);
    const { id, key, by, user } = bind.body;
    if (currentKey(view, id) !== key) return error(400, "the view doesn't show the binding's key is the account's now");
    if (by !== key) {
      const why = checkCert(key, cert!, store.revocations(id));
      if (why) return error(403, why);
      if (cert!.body.device !== by || cert!.body.role === "relay") return error(403, "the binding is signed by neither the account nor a full device of its");
    }
    const before = store.binding(id);
    if (before && !extends_(view, before.view)) return error(409, "the account's key has moved on since this view");
    const login = (ssh && (await bySsh(user, forgeBindBytes(bind.body), ssh))) || (await byToken(forgejo_token));
    if (!login || login.toLowerCase() !== user.toLowerCase()) return error(403, `nothing shows the binding's user is ${user}`);
    store.bind({ id, key, user: login, view, bind });
    drop((s) => s.account === id);
    return json({ account: id, user: login }, 201);
  }

  async function account(req: Request): Promise<Response> {
    const { view } = (await body(req)) as { view: AccountView };
    const b = view?.id ? store.binding(view.id) : null;
    if (!b) return error(404, "no such account here");
    const key = currentKey(view, b.id);
    if (!key) return error(400, "the view doesn't show its key");
    if (!extends_(view, b.view)) return error(409, "the account's key has moved on since this view");
    if (key !== b.key) {
      store.rotate(b.id, key, view);
      // Their certs were the old key's.
      drop((s) => s.account === b.id);
    }
    return json({ account: b.id, key });
  }

  async function revoke(req: Request): Promise<Response> {
    const { account, revocation, grant } = (await body(req)) as { account: string; revocation?: Signed<Revocation>; grant?: Signed<GrantRevocation> };
    const b = typeof account === "string" ? store.binding(account) : null;
    if (!b) return error(404, "no such account here");
    if (revocation) {
      if (!isRevocation(revocation.body) || revocation.body.account !== b.key || !verify(b.key, revocationBytes(revocation.body), revocation.sig)) return error(400, "revocation must be signed by the account's key");
      store.revoke(b.id, revocation);
      const d = revocation.body.device;
      drop((s) => s.account === b.id && s.checked.keys.includes(d));
    }
    if (grant) {
      const bad = checkGrantRevocation(grant);
      if (bad || grant.body.account !== b.id) return error(400, bad ?? "the revocation is for another account");
      store.revokeGrant(grant);
      const h = grant.body.grant;
      // Whether it counts (its issuer's or the account's) is checked at
      // the next session; these end now either way, and ask again.
      drop((s) => s.account === b.id && s.checked.grants.includes(h));
    }
    if (!revocation && !grant) return error(400, "revocation or grant");
    return json({ ok: true });
  }

  async function gate(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/gate/challenge" && method === "GET") {
      const t = now();
      for (const [n, until] of nonces) if (until <= t || nonces.size > MAX_NONCES) nonces.delete(n);
      const nonce = random(24);
      nonces.set(nonce, t + NONCE_MS);
      return json({ nonce, origin: config.origin });
    }
    if (path === "/gate/session" && method === "POST") return session(req);
    if (path === "/gate/session" && method === "GET") {
      const s = sessionOf(req);
      if (!s || s === "none") return error(401, "no session");
      return json({ account: s.account, user: s.user, holder: s.checked.holder, scope: s.checked.scope, expires: s.expires });
    }
    if (path === "/gate/bind" && method === "POST") return bind(req);
    if (path === "/gate/account" && method === "POST") return account(req);
    if (path === "/gate/revoke" && method === "POST") return revoke(req);
    return error(404, "not found");
  }

  // A grant's request ------------------------------------------------------------

  type Verdict = { ok: true; body?: BodyInit | null; dropEncoding?: boolean } | { ok: false; status: number; error: string };
  const no = (status: number, e: string): Verdict => ({ ok: false, status, error: e });

  async function allow(req: Request, url: URL, s: Session, scope: Scope): Promise<Verdict> {
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
      const res = await upstream(base + p, { headers: new Headers({ [config.userHeader]: s.user, accept: "application/json" }) });
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

  // Forwarding -------------------------------------------------------------------

  async function forward(req: Request, url: URL, user: string | null, body: BodyInit | null | undefined, dropEncoding = false): Promise<Response> {
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP.includes(k)) headers.set(k, v);
    });
    headers.delete(config.userHeader);
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

  async function fetch_(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && req.headers.get("origin") && config.corsOrigins.includes(req.headers.get("origin")!)) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": req.headers.get("origin")!,
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": "authorization, content-type, git-protocol, accept",
          "access-control-max-age": "600",
          vary: "origin",
        },
      });
    }
    if (url.pathname.startsWith("/gate/")) return cors(req, await gate(req, url));
    const s = sessionOf(req);
    if (s === "none") return forward(req, url, null, req.body);
    if (!s) return cors(req, new Response(JSON.stringify({ error: "the session is over; ask for another" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="corkboard"' } }));
    if (!s.checked.scope) return cors(req, await forward(req, url, s.user, req.body));
    const v = await allow(req, url, s, s.checked.scope);
    if (!v.ok) return cors(req, error(v.status, v.error));
    return cors(req, await forward(req, url, s.user, v.body, v.dropEncoding));
  }

  return { fetch: fetch_ };
}
