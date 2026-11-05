// The relay for end-to-end encrypted accounts, under /e2ee/*: in a relay
// of your own (index.ts), or beside the hosted Worker's other routes. An
// account here is its signing key; its devices sign in by signing a
// challenge, with a certificate the account key signed. Logs (log.ts) and
// attachments hold ciphertext only: nothing in the relay has a key to
// anything a client encrypted. See .agent/plans/e2ee.md, and lib/e2ee/relay.ts for the
// routes as a client calls them.
//
// Accounts (accounts.ts) are let in by whoever serves the routes: with an
// invite, by anyone, or made by an admin (createAccount with by).
//
// An account is known by its id (its first key: logs, blobs and grants are
// under it, and tokens name it) and by its current key, which certs must
// chain to. A rotation moves the current key on; it keeps the signed
// statements that get from the id to the key, so anyone can check them.
// An object can be shared with another account by a grant its owner signs;
// the member then reads (and with "write", pushes to) the owner's log.
//
// Signatures are checked with WebCrypto's Ed25519, against the bytes
// lib/e2ee/wire.ts lays out; that file is all of lib/e2ee the relay has.

import type { E2eeAccount, RelayAccounts } from "./accounts";
import type { Appended, Log } from "./log";
import type { Mailbox } from "./mailbox";
import type { Nodes } from "./nodes";
import type { Result } from "./result";
import {
  type AccountView,
  type Challenge,
  type Creation,
  type DeviceCert,
  type Grant,
  type NewOp,
  type Revocation,
  type Rotation,
  type Signed,
  type Snapshot,
  type TunnelRequest,
  type TunnelResponse,
  CODE_ALPHABET,
  HANDLE,
  KEY,
  LIMITS,
  OPAQUE,
  b64url,
  certBytes,
  challengeBytes,
  creationBytes,
  fromB64url,
  grantBytes,
  isCert,
  isGrant,
  isRevocation,
  isRotation,
  nodeHandle,
  normalizeCode,
  revocationBytes,
  rotationBytes,
} from "../../lib/e2ee/wire";

// What the routes need of the Worker serving them. ORIGIN is its own
// origin, no trailing slash: creations and challenges name it. MEDIA holds
// the blobs, under e2ee/<account>/. NODES: each account's nodes, by handle.
export type RelayEnv = {
  ORIGIN: string;
  LOG: DurableObjectNamespace<Log>;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  NODES: DurableObjectNamespace<Nodes>;
  MEDIA: R2Bucket;
};
export type Accounts = DurableObjectStub<RelayAccounts>;

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

const sha256 = async (s: string | Uint8Array) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : (s as Uint8Array<ArrayBuffer>))));
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const isSigned = (s: unknown): s is Signed<unknown> => !!s && typeof s === "object" && typeof (s as Signed<unknown>).sig === "string" && !!(s as Signed<unknown>).body;

async function certProblem(cert: unknown): Promise<string | null> {
  if (!isSigned(cert) || !isCert(cert.body)) return "cert must be a signed device certificate";
  if (!(await verify(cert.body.account, certBytes(cert.body), cert.sig))) return "the certificate isn't signed by its account";
  return null;
}

// A sealed box of a 32-byte root: its ephemeral key, the root, and a tag.
const SEALED_ROOT = 32 + 32 + 16;
// The most a sealed grant (a key and what it's for) can sensibly be.
const SEALED_GRANT = 4096;

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  return {};
}

// Making an account. by: the admin making it, who needs no invite.
export async function createAccount(request: Request, env: RelayEnv, accounts: Accounts, by: string | null): Promise<Response> {
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
  const made = (await accounts.createE2ee({ id: c.account, box: c.box, invite: c.invite, by, creation: creation as Signed<Creation> })) as Result<E2eeAccount>;
  return made.ok ? json({ account: made.value.id }, 201) : error(made.status, made.error);
}

// The device a request is from, by its token: as a bearer, or a browser
// socket's corkboard.bearer.<base64url> subprotocol. Kept a little while
// per isolate; a revocation here forgets it at once, and
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

async function whoIs(request: Request, r: Accounts): Promise<Who | null> {
  const token = bearer(request);
  if (!token?.startsWith(E2EE_TOKEN)) return null;
  const hash = await sha256(token);
  const hit = cache.get(hash);
  if (hit && hit.until > Date.now()) return hit.who;
  const t = await r.e2eeToken(hash);
  const who = t ? { account: t.account, device: t.device } : null;
  cache.set(hash, { who, until: Math.min(Date.now() + CACHE_MS, t?.expires ?? Infinity) });
  return who;
}

const PAIR = /^\/e2ee\/pair\/([^/]+)(?:\/(commit|join|reveal|deliver|cancel))?$/;
const LOG = /^\/e2ee\/log\/([^/]+)(\/live|\/snapshot)?$/;
const BLOB = /^\/e2ee\/blob\/([^/]+)$/;
const ACCOUNT = /^\/e2ee\/accounts\/([^/]+)$/;
const GRANT = /^\/e2ee\/grants\/([^/]+)\/([^/]+)$/;

const mailbox = (env: RelayEnv, code: string) => env.MAILBOX.get(env.MAILBOX.idFromName(code));
// An account's log of an object: its own, or the owner's it's shared.
const logOf = (env: RelayEnv, owner: string, object: string) => env.LOG.get(env.LOG.idFromName(`${owner}/${object}`));
const blobKey = (who: Who, id: string) => `e2ee/${who.account}/${id}`;
const nodesOf = (env: RelayEnv, handle: string) => env.NODES.get(env.NODES.idFromName(handle));

// The tunnel to an account's nodes (nodes.ts), for whoever its node lets
// in: <relay>/n/<handle>/… as the node's /…, and RFC 8414's path-suffixed
// well-knowns (/.well-known/<name>/n/<handle>) as its /.well-known/<name>.
// Undefined when the path isn't the tunnel's. No token here: the node
// asks for its own.
const TUNNEL = /^\/n\/([^/]+)(\/.*)?$/;
const WELL_KNOWN = /^\/\.well-known\/([^/]+)\/n\/([^/]+)(\/.*)?$/;
// What isn't passed on: the hop's own, and what Cloudflare adds.
const HOP = /^(host|connection|keep-alive|transfer-encoding|upgrade|content-length|cookie|cf-.*|x-real-ip|x-forwarded-.*)$/i;

export async function tunnel(request: Request, env: RelayEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const t = url.pathname.match(TUNNEL);
  const w = t ? undefined : url.pathname.match(WELL_KNOWN);
  if (!t && !w) return;
  const handle = t ? t[1] : w![2];
  const path = t ? (t[2] ?? "/") : `/.well-known/${w![1]}${w![3] ?? ""}`;
  if (!HANDLE.test(handle)) return error(404, "no such node");
  if (request.headers.get("Upgrade")) return error(501, "the tunnel carries requests, not sockets");
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > LIMITS.tunnel) return error(413, `a request through the tunnel is at most ${LIMITS.tunnel} bytes`);
  const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  if (bytes && bytes.length > LIMITS.tunnel) return error(413, `a request through the tunnel is at most ${LIMITS.tunnel} bytes`);
  const headers = [...request.headers].filter(([k]) => !HOP.test(k)) as [string, string][];
  headers.push(["x-forwarded-proto", "https"]);
  const req: TunnelRequest = { id: random(12), method: request.method, path: path + url.search, headers, ...(bytes?.length && { body: b64url(bytes) }) };
  const r = (await nodesOf(env, handle).forward(req)) as TunnelResponse | { none: true } | { timeout: true };
  if ("none" in r) return error(503, "none of this account's nodes is connected");
  if ("timeout" in r) return error(504, "the node didn't answer in time");
  const out = new Headers(r.headers.filter(([k]) => !HOP.test(k)));
  const nobody = r.status === 204 || r.status === 304 || request.method === "HEAD";
  return new Response(nobody || !r.body ? null : fromB64url(r.body), { status: r.status, headers: out });
}

export async function e2ee(request: Request, env: RelayEnv, r: Accounts): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/e2ee/accounts") return method === "POST" ? createAccount(request, env, r, null) : error(405, "method not allowed");

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
    // The cert names the key it was signed by: the account's id, or after a
    // rotation its key now. One signed by a key it had before no longer counts.
    const account = (await r.e2eeAccountByKey(crt.account)) as E2eeAccount | undefined;
    if (!account) return error(403, "no such account here");
    if (account.status !== "active") return error(403, `this account is ${account.status}`);
    if (crt.account !== account.key) return error(401, "the account's key has changed since this certificate: POST /e2ee/rotated");
    if (await r.isRevoked(account.id, crt.device)) return error(403, "this device has been revoked");
    const token = E2EE_TOKEN + random(32);
    const expires = Date.now() + TOKEN_TTL;
    await r.mintE2eeToken(await sha256(token), account.id, crt.device, expires);
    return json({ token, expires, account: account.id });
  }

  // Signed by the account's key now; kept under its id.
  if (path === "/e2ee/revoke") {
    if (method !== "POST") return error(405, "method not allowed");
    const { revocation } = await body(request);
    if (!isSigned(revocation) || !isRevocation(revocation.body)) return error(400, "revocation must be a signed revocation");
    const v = revocation.body as Revocation;
    if (!(await verify(v.account, revocationBytes(v), revocation.sig))) return error(401, "the revocation isn't signed by its account");
    const account = (await r.e2eeAccountByKey(v.account)) as E2eeAccount | undefined;
    if (!account) return error(404, "no such account here");
    if (account.key !== v.account) return error(401, "the revocation is signed by a key the account had before");
    await r.revokeE2ee(account.id, v.device, v.at, JSON.stringify(revocation));
    for (const [k, c] of cache) if (c.who?.account === account.id && c.who.device === v.device) cache.delete(k);
    return json({ ok: true });
  }

  // A device whose cert stopped counting at a rotation, fetching its way
  // onto the new key: asked with no token, as a challenge is.
  if (path === "/e2ee/rotated") {
    if (method !== "POST") return error(405, "method not allowed");
    const { account, device } = await body(request);
    if (typeof account !== "string" || !KEY.test(account) || typeof device !== "string" || !KEY.test(device)) return error(400, "account and device must be keys");
    const got = await r.e2eeRotated(account, device);
    return got ? json(got) : error(404, "nothing for that device");
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
    const who = await whoIs(request, r);
    if (!who) return error(401, "sign in with a device of the account first");
    if (!step) return method === "GET" ? reply(await box.viewApprover(code, who.account)) : error(405, "method not allowed");
    if (method !== "POST") return error(405, "method not allowed");
    if (step === "commit") return reply(await box.commit(who.account, String(b.commit ?? "")));
    if (step === "reveal") return reply(await box.reveal(who.account, String(b.approver ?? "")));
    if (step === "deliver") return reply(await box.deliver(who.account, b as never));
    if (step === "cancel") return reply(await box.cancel({ account: who.account }));
    return error(404, "not found");
  }

  const who = await whoIs(request, r);
  if (!who) return error(401, "sign in with a device of an encrypted account (POST /e2ee/challenge, then /e2ee/token)");

  if (path === "/e2ee/revoked") return method === "GET" ? json(await r.e2eeRevocations(who.account)) : error(405, "method not allowed");

  // The account's nodes: which are connected and which leads (GET), the
  // leader (PUT { device | null }), and a node's own socket (live).
  if (path === "/e2ee/nodes" || path === "/e2ee/nodes/leader" || path === "/e2ee/nodes/live") {
    const handle = await nodeHandle(who.account);
    const stub = nodesOf(env, handle);
    if (path === "/e2ee/nodes/live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
      const name = (url.searchParams.get("name") ?? "").trim().slice(0, 100);
      const res = await stub.fetch(new Request(request.url, { headers: { Upgrade: "websocket", "X-Device": who.device, ...(name && { "X-Device-Name": name }) } }));
      if (res.status !== 101) return res;
      const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
      return new Response(null, { status: 101, webSocket: res.webSocket, headers: offered.includes("corkboard") ? { "Sec-WebSocket-Protocol": "corkboard" } : {} });
    }
    if (path === "/e2ee/nodes") return method === "GET" ? json({ handle, url: `${env.ORIGIN}/n/${handle}`, ...(await stub.status()) }) : error(405, "method not allowed");
    if (method !== "PUT") return error(405, "method not allowed");
    const { device } = await body(request);
    if (!(device === null || (typeof device === "string" && KEY.test(device)))) return error(400, "device must be a device id, or null for none");
    return json({ handle, url: `${env.ORIGIN}/n/${handle}`, ...(await stub.setLeader(device)) });
  }

  const acct = path.match(ACCOUNT);
  if (acct) {
    if (method !== "GET") return error(405, "method not allowed");
    const a = (await r.e2eeAccount(decodeURIComponent(acct[1]))) as E2eeAccount | undefined;
    if (!a) return error(404, "no such account here");
    const view: AccountView = { id: a.id, key: a.key, box: a.box, proof: { creation: a.creation as Signed<Creation>, rotations: a.rotations } };
    return json(view);
  }

  if (path === "/e2ee/rotate") {
    if (method !== "POST") return error(405, "method not allowed");
    const b = await body(request);
    const { rotation, certs, roots } = b;
    if (!isSigned(rotation) || !isRotation(rotation.body)) return error(400, "rotation must be a signed rotation");
    const rot = rotation.body as Rotation;
    if (rot.account !== who.account) return error(403, "that rotation is for another account");
    const account = (await r.e2eeAccount(who.account)) as E2eeAccount | undefined;
    if (!account) return error(404, "no such account here");
    if (rot.from !== account.key) return error(409, "the account's key has changed since: rotate from the one it has now");
    if (!(await verify(rot.from, rotationBytes(rot), rotation.sig))) return error(401, "the rotation isn't signed by the account's key");
    // The devices kept: a cert from the new key, and the new root sealed to it, each.
    if (!Array.isArray(certs) || !certs.length || certs.length > LIMITS.members) return error(400, `certs must be 1 to ${LIMITS.members} certificates from the new key`);
    if (!roots || typeof roots !== "object" || Array.isArray(roots)) return error(400, "roots must map each device kept to its sealed root");
    const sealed = roots as Record<string, unknown>;
    const bundles: { cert: Signed<DeviceCert>; root: string }[] = [];
    for (const cert of certs) {
      const bad = await certProblem(cert);
      if (bad) return error(400, bad);
      const c = (cert as Signed<DeviceCert>).body;
      if (c.account !== rot.to) return error(400, "every certificate must be from the new key");
      if (bundles.some((x) => x.cert.body.device === c.device)) return error(400, "a device is kept once");
      const root = sealed[c.device];
      let n = 0;
      try {
        n = typeof root === "string" ? fromB64url(root).length : 0;
      } catch {}
      if (n !== SEALED_ROOT) return error(400, "roots must have each device kept's root, sealed to its box key");
      bundles.push({ cert: cert as Signed<DeviceCert>, root: root as string });
    }
    if (Object.keys(sealed).length !== bundles.length) return error(400, "roots has a device that isn't kept");
    const done = (await r.rotateE2ee(account.id, rotation as Signed<Rotation>, bundles)) as Result<E2eeAccount>;
    if (!done.ok) return error(done.status, done.error);
    for (const [k, c] of cache) if (c.who?.account === account.id) cache.delete(k);
    return json({ ok: true });
  }

  if (path === "/e2ee/grants") {
    if (method === "GET") {
      const object = url.searchParams.get("object") ?? "";
      if (!OPAQUE.test(object)) return error(400, "?object= must be an object id");
      return json(await r.grants({ owner: who.account, object }));
    }
    if (method !== "POST") return error(405, "method not allowed");
    const { grant, sealed } = await body(request);
    if (!isSigned(grant) || !isGrant(grant.body)) return error(400, "grant must be a signed grant");
    const g = grant.body as Grant;
    if (g.owner !== who.account) return error(403, "a grant's owner is the account granting it");
    const owner = (await r.e2eeAccount(who.account)) as E2eeAccount | undefined;
    if (!owner) return error(404, "no such account here");
    if (!(await verify(owner.key, grantBytes(g), grant.sig))) return error(401, "the grant isn't signed by the account's key");
    let box: Uint8Array;
    try {
      box = typeof sealed === "string" ? fromB64url(sealed) : new Uint8Array();
    } catch {
      box = new Uint8Array();
    }
    if (box.length < 48 || box.length > SEALED_GRANT) return error(400, "sealed must be the key sealed to the member, base64url");
    if ((await sha256(box)) !== g.wrapped) return error(400, "the grant's wrapped isn't the SHA-256 of sealed");
    return reply((await r.putGrant(grant as Signed<Grant>, sealed as string, LIMITS.members)) as Result<{ ok: true }>);
  }

  const grant = path.match(GRANT);
  if (grant) {
    if (method !== "DELETE") return error(405, "method not allowed");
    const [object, member] = [grant[1], grant[2]];
    if (!OPAQUE.test(object) || !KEY.test(member)) return error(400, "an object id and a member's account id");
    await r.dropGrant(who.account, object, member);
    // Whatever socket the member had on the log goes too.
    await logOf(env, who.account, object).drop(member);
    return json({ ok: true });
  }

  if (path === "/e2ee/shared") return method === "GET" ? json(await r.grants({ member: who.account })) : error(405, "method not allowed");

  const log = path.match(LOG);
  if (log) {
    const object = log[1];
    if (!OPAQUE.test(object)) return error(400, "an object id is 16 to 64 base64url characters");
    // Another account's log, while it shares the object with this one.
    const owner = url.searchParams.get("owner");
    if (owner !== null) {
      if (!KEY.test(owner)) return error(400, "?owner= must be an account id");
      if (log[2] === "/snapshot" || method === "DELETE") return error(403, "only the owner compacts or deletes a log");
      const role = await r.grantRole(owner, object, who.account);
      if (!role) return error(403, "that object isn't shared with this account");
      if (method === "POST" && role !== "write") return error(403, "that object is shared with this account to read only");
    }
    const stub = logOf(env, owner ?? who.account, object);
    if (log[2] === "/live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
      const res = await stub.fetch(new Request(request.url, { headers: { Upgrade: "websocket", "X-Account": who.account } }));
      if (res.status !== 101) return res;
      const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
      return new Response(null, { status: 101, webSocket: res.webSocket, headers: offered.includes("corkboard") ? { "Sec-WebSocket-Protocol": "corkboard" } : {} });
    }
    if (log[2] === "/snapshot") {
      if (method !== "POST") return error(405, "method not allowed");
      const s = (await body(request)) as Snapshot;
      return reply((await stub.snapshot(s)) as Result<{ upTo: number; epoch: number }>);
    }
    if (method === "GET") return json(await stub.read(Number(url.searchParams.get("since") ?? 0), Number(url.searchParams.get("limit") ?? LIMITS.read)));
    if (method === "DELETE") {
      // The log's grants go with it.
      await stub.deleteAll();
      await r.dropGrant(who.account, object);
      return json({ ok: true });
    }
    if (method !== "POST") return error(405, "method not allowed");
    const { ops } = await body(request);
    const appended = (await stub.append(who.device, ops as NewOp[])) as Appended;
    if (appended.ok) return json({ ops: appended.value });
    return "epoch" in appended ? json({ error: appended.error, epoch: appended.epoch }, appended.status) : error(appended.status, appended.error);
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


