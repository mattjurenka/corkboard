// The relay for end-to-end encrypted accounts, beside the plaintext API
// and Google sign-in, which go on working as they were. An account here is
// its signing key; its devices sign in by signing a challenge, with a
// certificate the account key signed. Logs (log.ts) and attachments hold
// ciphertext only: nothing in this Worker has a key to anything a client
// encrypted. See .agent/plans/e2ee.md, and lib/e2ee/relay.ts for the
// routes as a client calls them.
//
// The registry (registry.ts) lets accounts in, as it does Google ones:
// with an invite, or made by an admin (POST /api/e2ee/accounts, api.ts).
//
// Signatures are checked with WebCrypto's Ed25519, against the bytes
// lib/e2ee/wire.ts lays out; that file is all of lib/e2ee the Worker has.

import type { Env } from "./index";
import { type E2eeAccount, registry } from "./registry";
import type { Result } from "./board";
import {
  type Challenge,
  type Creation,
  type DeviceCert,
  type NewOp,
  type Revocation,
  type Signed,
  CODE_ALPHABET,
  KEY,
  LIMITS,
  OPAQUE,
  b64url,
  certBytes,
  challengeBytes,
  creationBytes,
  fromB64url,
  isCert,
  isRevocation,
  normalizeCode,
  revocationBytes,
} from "../../lib/e2ee/wire";

export const E2EE_TOKEN = "cbe_";
const TOKEN_TTL = 24 * 3600_000;
const CHALLENGE_TTL = 2 * 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);
const reply = <T>(r: { ok: true; value: T } | { ok: false; status: number; error: string }, status = 200) => (r.ok ? json(r.value, status) : error(r.status, r.error));

async function verify(pub: string, bytes: Uint8Array, sig: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64url(pub), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64url(sig), bytes);
  } catch {
    return false;
  }
}

const sha256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const isSigned = (s: unknown): s is Signed<unknown> => !!s && typeof s === "object" && typeof (s as Signed<unknown>).sig === "string" && !!(s as Signed<unknown>).body;

async function certProblem(cert: unknown): Promise<string | null> {
  if (!isSigned(cert) || !isCert(cert.body)) return "cert must be a signed device certificate";
  if (!(await verify(cert.body.account, certBytes(cert.body), cert.sig))) return "the certificate isn't signed by its account";
  return null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  return {};
}

// Making an account. by: the admin making it (api.ts), who needs no invite.
export async function createAccount(request: Request, env: Env, by: string | null): Promise<Response> {
  const { creation, cert } = await body(request);
  if (!isSigned(creation)) return error(400, "creation must be a signed statement");
  const c = creation.body as Creation;
  if (c?.v !== 1 || !KEY.test(c.account) || !KEY.test(c.box) || !(c.invite === null || typeof c.invite === "string")) return error(400, "creation must name the account, its box key and the invite");
  if (c.origin !== env.ORIGIN) return error(400, `creation is for ${c.origin}, not this relay`);
  if (!(await verify(c.account, creationBytes(c), creation.sig))) return error(400, "creation isn't signed by its account");
  // The first device comes with it, so the account is never without one.
  const bad = await certProblem(cert);
  if (bad) return error(400, bad);
  if ((cert as Signed<DeviceCert>).body.account !== c.account) return error(400, "the certificate is for another account");
  const made = (await registry(env).createE2ee({ id: c.account, box: c.box, invite: c.invite, by })) as Result<E2eeAccount>;
  return made.ok ? json({ account: made.value.id }, 201) : error(made.status, made.error);
}

// The device a request is from, by its token: as a bearer, or a browser
// socket's corkboard.bearer.<base64url> subprotocol. Kept a little while
// per isolate, as accountOf is; a revocation here forgets it at once, and
// elsewhere within CACHE_MS.
const CACHE_MS = 30_000;
const cache = new Map<string, { who: Who | null; until: number }>();
export type Who = { account: string; device: string };

function bearer(request: Request): string | undefined {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  const b64 = offered.find((p) => p.startsWith("corkboard.bearer."))?.slice("corkboard.bearer.".length);
  if (!b64) return;
  try {
    return new TextDecoder().decode(fromB64url(b64));
  } catch {
    return;
  }
}

async function whoIs(request: Request, env: Env): Promise<Who | null> {
  const token = bearer(request);
  if (!token?.startsWith(E2EE_TOKEN)) return null;
  const hash = await sha256(token);
  const hit = cache.get(hash);
  if (hit && hit.until > Date.now()) return hit.who;
  const t = await registry(env).e2eeToken(hash);
  const who = t ? { account: t.account, device: t.device } : null;
  cache.set(hash, { who, until: Math.min(Date.now() + CACHE_MS, t?.expires ?? Infinity) });
  return who;
}

const PAIR = /^\/e2ee\/pair\/([^/]+)(?:\/(commit|join|reveal|deliver|cancel))?$/;
const LOG = /^\/e2ee\/log\/([^/]+)(\/live)?$/;
const BLOB = /^\/e2ee\/blob\/([^/]+)$/;

const mailbox = (env: Env, code: string) => env.MAILBOX.get(env.MAILBOX.idFromName(code));
const logOf = (env: Env, who: Who, object: string) => env.LOG.get(env.LOG.idFromName(`${who.account}/${object}`));
const blobKey = (who: Who, id: string) => `e2ee/${who.account}/${id}`;

export async function e2ee(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const r = registry(env);

  if (path === "/e2ee/accounts") return method === "POST" ? createAccount(request, env, null) : error(405, "method not allowed");

  if (path === "/e2ee/challenge") {
    if (method !== "POST") return error(405, "method not allowed");
    const { account, device } = await body(request);
    if (typeof account !== "string" || !KEY.test(account) || typeof device !== "string" || !KEY.test(device)) return error(400, "account and device must be keys");
    // Asked whether or not the account exists, so the answer says nothing of it.
    const nonce = random(32);
    const expires = await r.e2eeChallenge(account, device, nonce, CHALLENGE_TTL);
    return json({ nonce, expires });
  }

  if (path === "/e2ee/token") {
    if (method !== "POST") return error(405, "method not allowed");
    const { cert, answer } = await body(request);
    const bad = await certProblem(cert);
    if (bad) return error(401, bad);
    const crt = (cert as Signed<DeviceCert>).body;
    if (!isSigned(answer)) return error(400, "answer must be a signed challenge");
    const a = answer.body as Challenge;
    if (a?.v !== 1 || a.origin !== env.ORIGIN || a.account !== crt.account || a.device !== crt.device || typeof a.nonce !== "string") return error(401, "the answer doesn't match the certificate, or is for another relay");
    if (!(await verify(crt.device, challengeBytes(a), answer.sig))) return error(401, "the answer isn't signed by the device");
    if (!(await r.takeE2eeChallenge(a.nonce, a.account, a.device))) return error(401, "that challenge is unknown, used or expired");
    const account = await r.e2eeAccount(crt.account);
    if (!account) return error(403, "no such account here");
    if (account.status !== "active") return error(403, `this account is ${account.status}`);
    if (await r.isRevoked(crt.account, crt.device)) return error(403, "this device has been revoked");
    const token = E2EE_TOKEN + random(32);
    const expires = Date.now() + TOKEN_TTL;
    await r.mintE2eeToken(await sha256(token), crt.account, crt.device, expires);
    return json({ token, expires });
  }

  if (path === "/e2ee/revoke") {
    if (method !== "POST") return error(405, "method not allowed");
    const { revocation } = await body(request);
    if (!isSigned(revocation) || !isRevocation(revocation.body)) return error(400, "revocation must be a signed revocation");
    const v = revocation.body as Revocation;
    if (!(await verify(v.account, revocationBytes(v), revocation.sig))) return error(401, "the revocation isn't signed by its account");
    if (!(await r.e2eeAccount(v.account))) return error(404, "no such account here");
    await r.revokeE2ee(v.account, v.device, v.at, JSON.stringify(revocation));
    for (const [k, c] of cache) if (c.who?.account === v.account && c.who.device === v.device) cache.delete(k);
    return json({ ok: true });
  }

  // A new device's pairing starts with no account: the code and a secret
  // that is its side of the mailbox.
  if (path === "/e2ee/pair") {
    if (method !== "POST") return error(405, "method not allowed");
    const secret = random(32);
    for (let i = 0; i < 5; i++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => CODE_ALPHABET[b & 31]).join("");
      const expires = await mailbox(env, code).init(await sha256(secret));
      if (expires) return json({ code, secret, expires }, 201);
    }
    return error(503, "couldn't make a pairing code; try again");
  }

  const pair = path.match(PAIR);
  if (pair) {
    const code = normalizeCode(decodeURIComponent(pair[1]));
    if (!code) return error(404, "no such pairing");
    const step = pair[2];
    const box = mailbox(env, code);
    const b = await body(request);
    // The new device's steps carry its secret, in the body (never the URL).
    if (typeof b.secret === "string" && (method === "POST" && (!step || step === "join" || step === "cancel"))) {
      const secret = await sha256(b.secret);
      if (!step) return reply(await box.viewNew(code, secret));
      if (step === "join") return reply(await box.join(secret, b as never));
      return reply(await box.cancel({ secret }));
    }
    const who = await whoIs(request, env);
    if (!who) return error(401, "sign in with a device of the account first");
    if (!step) return method === "GET" ? reply(await box.viewApprover(code, who.account)) : error(405, "method not allowed");
    if (method !== "POST") return error(405, "method not allowed");
    if (step === "commit") return reply(await box.commit(who.account, String(b.commit ?? "")));
    if (step === "reveal") return reply(await box.reveal(who.account, String(b.approver ?? "")));
    if (step === "deliver") return reply(await box.deliver(who.account, b as never));
    if (step === "cancel") return reply(await box.cancel({ account: who.account }));
    return error(404, "not found");
  }

  const who = await whoIs(request, env);
  if (!who) return error(401, "sign in with a device of an encrypted account (POST /e2ee/challenge, then /e2ee/token)");

  if (path === "/e2ee/revoked") return method === "GET" ? json(await r.e2eeRevocations(who.account)) : error(405, "method not allowed");

  const log = path.match(LOG);
  if (log) {
    const object = log[1];
    if (!OPAQUE.test(object)) return error(400, "an object id is 16 to 64 base64url characters");
    const stub = logOf(env, who, object);
    if (log[2]) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
      const res = await stub.fetch(new Request(request.url, { headers: { Upgrade: "websocket" } }));
      if (res.status !== 101) return res;
      const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
      return new Response(null, { status: 101, webSocket: res.webSocket, headers: offered.includes("corkboard") ? { "Sec-WebSocket-Protocol": "corkboard" } : {} });
    }
    if (method === "GET") return json(await stub.read(Number(url.searchParams.get("since") ?? 0), Number(url.searchParams.get("limit") ?? LIMITS.read)));
    if (method !== "POST") return error(405, "method not allowed");
    const { ops } = await body(request);
    const appended = (await stub.append(who.device, ops as NewOp[])) as Result<{ id: string; pos: number }[]>;
    return appended.ok ? json({ ops: appended.value }) : error(appended.status, appended.error);
  }

  const blob = path.match(BLOB);
  if (blob) {
    const id = blob[1];
    if (!OPAQUE.test(id)) return error(400, "a blob id is 16 to 64 base64url characters");
    const key = blobKey(who, id);
    if (method === "GET") {
      const o = await env.MEDIA.get(key);
      return o ? new Response(o.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(o.size) } }) : error(404, "no such blob");
    }
    if (method === "PUT") {
      const length = Number(request.headers.get("Content-Length") ?? NaN);
      if (length > LIMITS.blob) return error(413, `a blob is at most ${LIMITS.blob} bytes`);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > LIMITS.blob) return error(413, `a blob is at most ${LIMITS.blob} bytes`);
      if (bytes.length < 24 + 16) return error(400, "a blob is its nonce and ciphertext");
      // Blobs never change: a new version is a new id.
      if (await env.MEDIA.head(key)) return error(409, "that blob exists");
      await env.MEDIA.put(key, bytes);
      return json({ id, size: bytes.length }, 201);
    }
    if (method === "DELETE") {
      await env.MEDIA.delete(key);
      return new Response(null, { status: 204 });
    }
    return error(405, "method not allowed");
  }

  return error(404, "not found");
}


