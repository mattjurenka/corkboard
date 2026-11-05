// The relay's API, as a client calls it (relay/src/routes.ts serves it):
//
//   POST /e2ee/accounts           { creation, cert }: a new account, with an invite
//                                 (or /api/e2ee/accounts, an admin's Google token, without)
//   POST /e2ee/challenge          { account, device }: { nonce, expires }
//   POST /e2ee/token              { cert, answer }: { token, expires }
//   POST /e2ee/revoke             { revocation }: the account key's own signature is the auth
//   GET  /e2ee/revoked            the account's revocations, for its devices to check
//   /e2ee/pair...                 pairing mailboxes (pairing.ts)
//   GET  /e2ee/accounts/:id       anyone's public keys, with the proof they're the id's (AccountView)
//   POST /e2ee/rotate             { rotation, certs, roots }: the account onto a new key
//   POST /e2ee/rotated            { account, device }: a device's way onto it (Rotated)
//   POST /e2ee/log/:object        { ops: NewOp[] }: { ops: [{ id, pos }] }; 409 { epoch } on a stale one
//   GET  /e2ee/log/:object        ?since=&limit=: LogRead
//   GET  /e2ee/log/:object/live   WebSocket, ?since=: { ops } and { snapshot } messages, catch-up first
//   POST /e2ee/log/:object/snapshot   Snapshot (the owner's)
//   DELETE /e2ee/log/:object      the whole log (the owner's)
//   ?owner=<account id> on any of the log's: a log shared with this account by its owner
//   POST /e2ee/grants             { grant, sealed }; DELETE /e2ee/grants/:object/:member
//   GET  /e2ee/grants?object=     an object's grants (the owner's); GET /e2ee/shared, those to me
//   PUT  /e2ee/blob/:id           an encrypted attachment; GET it back
//   GET  /e2ee/nodes              the account's connected nodes and its leader (NodesView), its handle and url
//   PUT  /e2ee/nodes/leader       { device | null }
//   GET  /e2ee/nodes/live         WebSocket: this device as a node, answering the tunnel's
//                                 TunnelRequests (<relay>/n/<handle>/…) with TunnelResponses
//
// Everything but creating an account, challenges, revocations, rotated and the new device's
// side of pairing wants a token from /e2ee/token, as a bearer (or, for a
// browser's socket, the corkboard.bearer.<base64url> subprotocol). A token
// that's expired or refused is got again, once, from the device's keys.

import { answer, type Device } from "./device";
import type { Delivery, MailboxView, PairTransport } from "./pairing";
import { EpochChanged, type LogTransport } from "./sync";
import type { AccountView, Creation, DeviceCert, Grant, LogRead, NewOp, NodesView, Revocation, Rotated, Rotation, Signed, Snapshot, TunnelRequest, TunnelResponse, WireOp } from "./wire";
import { LIMITS, b64url, fromB64url, utf8 } from "./wire";

export type Nodes = NodesView & { handle: string; url: string };

// account: the account's id, which after a rotation is no longer the key its certs name.
export type Token = { token: string; expires: number; account?: string };

// fetch as the relay is called with it: a test's Worker, or the real one.
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type RelayOptions = {
  origin: string;
  fetch?: Fetch;
  // A signed-in device's: what it gets tokens with.
  device?: Device;
  cert?: Signed<DeviceCert>;
  token?: Token;
  onToken?(t: Token): void;
  // For live(): the WebSocket to use (the bridge's Bun one, a browser's, a test's).
  socket?(url: string, protocols: string[]): WebSocket;
};

export class Relay implements PairTransport, LogTransport {
  readonly origin: string;
  private f: Fetch;
  constructor(private o: RelayOptions) {
    this.origin = o.origin.replace(/\/$/, "");
    this.f = o.fetch ?? ((input, init) => fetch(input, init));
  }

  // The account's id: what the relay last said, or before a rotation, the
  // key its cert names, which is the same.
  get account() {
    return this.o.token?.account ?? this.o.cert?.body.account;
  }

  // A new cert (after a rotation): the next call signs in with it.
  useCert(cert: Signed<DeviceCert>) {
    this.o.cert = cert;
    this.o.token = undefined;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.origin}${path}`, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new RelayError(res.status, `${method} ${path}: ${json.error ?? res.status}`, json);
    return json as T;
  }

  async token(fresh = false): Promise<string> {
    const t = this.o.token;
    if (!fresh && t && t.expires - 60_000 > Date.now()) return t.token;
    return (await this.signIn()).token;
  }

  async signIn(): Promise<Token> {
    const { device, cert } = this.o;
    if (!device || !cert) throw new Error("this relay client has no device to sign in with");
    const { nonce } = await this.call<{ nonce: string }>("POST", "/e2ee/challenge", { account: cert.body.account, device: device.id });
    const t = await this.call<Token>("POST", "/e2ee/token", { cert, answer: answer(device, { origin: this.origin, nonce, account: cert.body.account }) });
    this.o.token = t;
    this.o.onToken?.(t);
    return t;
  }

  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, body, { Authorization: `Bearer ${await this.token()}` });
    } catch (e) {
      if (!(e instanceof RelayError) || e.status !== 401 || !this.o.device) throw e;
      return this.call<T>(method, path, body, { Authorization: `Bearer ${await this.token(true)}` });
    }
  }

  // Accounts ---------------------------------------------------------------------

  // With an invite; or with an admin's Google access token (bearer) and none.
  createAccount(creation: Signed<Creation>, cert: Signed<DeviceCert>, bearer?: string) {
    return this.call<{ account: string }>("POST", bearer ? "/api/e2ee/accounts" : "/e2ee/accounts", { creation, cert }, bearer ? { Authorization: `Bearer ${bearer}` } : {});
  }

  revoke(revocation: Signed<Revocation>) {
    return this.call<{ ok: true }>("POST", "/e2ee/revoke", { revocation });
  }

  revoked() {
    return this.authed<Signed<Revocation>[]>("GET", "/e2ee/revoked");
  }

  // Pairing ----------------------------------------------------------------------

  create() {
    return this.call<{ code: string; secret: string; expires: number }>("POST", "/e2ee/pair");
  }
  view(code: string, secret?: string) {
    return secret ? this.call<MailboxView>("POST", `/e2ee/pair/${code}`, { secret }) : this.authed<MailboxView>("GET", `/e2ee/pair/${code}`);
  }
  async commit(code: string, commit: string) {
    await this.authed("POST", `/e2ee/pair/${code}/commit`, { commit });
  }
  async join(code: string, secret: string, j: { box: string; device: string; name: string }) {
    await this.call("POST", `/e2ee/pair/${code}/join`, { secret, ...j });
  }
  async reveal(code: string, approver: string) {
    await this.authed("POST", `/e2ee/pair/${code}/reveal`, { approver });
  }
  async deliver(code: string, d: Delivery) {
    await this.authed("POST", `/e2ee/pair/${code}/deliver`, d);
  }
  async cancel(code: string, secret?: string) {
    if (secret) await this.call("POST", `/e2ee/pair/${code}/cancel`, { secret });
    else await this.authed("POST", `/e2ee/pair/${code}/cancel`, {});
  }

  // Accounts' keys, rotation ---------------------------------------------------

  accountView(id: string) {
    return this.authed<AccountView>("GET", `/e2ee/accounts/${id}`);
  }

  rotate(rotation: Signed<Rotation>, certs: Signed<DeviceCert>[], roots: Record<string, string>) {
    return this.authed<{ ok: true }>("POST", "/e2ee/rotate", { rotation, certs, roots });
  }

  rotated(account: string, device: string) {
    return this.call<Rotated>("POST", "/e2ee/rotated", { account, device });
  }

  // Sharing ----------------------------------------------------------------------

  grant(grant: Signed<Grant>, sealed: string) {
    return this.authed<{ ok: true }>("POST", "/e2ee/grants", { grant, sealed });
  }
  ungrant(object: string, member: string) {
    return this.authed<{ ok: true }>("DELETE", `/e2ee/grants/${object}/${member}`);
  }
  grants(object: string) {
    return this.authed<{ grant: Signed<Grant>; sealed: string }[]>("GET", `/e2ee/grants?object=${object}`);
  }
  shared() {
    return this.authed<{ grant: Signed<Grant>; sealed: string }[]>("GET", "/e2ee/shared");
  }

  // Logs -------------------------------------------------------------------------

  // This account's own logs, or with owner, one another account shares.
  private logPath(object: string, rest = "", owner?: string, query: Record<string, string | number | undefined> = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, owner })) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return `/e2ee/log/${object}${rest}${s ? `?${s}` : ""}`;
  }

  async append(object: string, ops: NewOp[], owner?: string) {
    try {
      return (await this.authed<{ ops: { id: string; pos: number }[] }>("POST", this.logPath(object, "", owner), { ops })).ops;
    } catch (e) {
      if (e instanceof RelayError && e.status === 409 && typeof e.body.epoch === "number") throw new EpochChanged(e.body.epoch);
      throw e;
    }
  }

  read(object: string, since: number, limit?: number, owner?: string) {
    return this.authed<LogRead>("GET", this.logPath(object, "", owner, { since, limit }));
  }

  async snapshot(object: string, s: Snapshot) {
    await this.authed("POST", this.logPath(object, "/snapshot"), s);
  }

  async deleteLog(object: string) {
    await this.authed("DELETE", this.logPath(object));
  }

  // A log shared with this account, as a replica's transport: the owner's
  // log, which only the owner compacts.
  shares(owner: string): LogTransport {
    return {
      append: (object, ops) => this.append(object, ops, owner),
      read: (object, since, limit) => this.read(object, since, limit, owner),
      subscribe: (object, since, on) => this.subscribe(object, since, on, owner),
    };
  }

  // Reconnects after a drop, from the last op it saw, until stopped.
  subscribe(object: string, since: number, on: (ops: WireOp[], snapshot?: Snapshot) => void, owner?: string): () => void {
    let stopped = false;
    let ws: WebSocket | undefined;
    let cursor = since;
    const make = this.o.socket ?? ((url, protocols) => new WebSocket(url, protocols));
    const connect = async () => {
      if (stopped) return;
      const t = await this.token().catch(() => undefined);
      if (!t) return void setTimeout(connect, 5000);
      const url = `${this.origin.replace(/^http/, "ws")}${this.logPath(object, "/live", owner, { since: cursor })}`;
      ws = make(url, ["corkboard", `corkboard.bearer.${b64url(utf8(t))}`]);
      ws.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(String(e.data)) as { ops?: WireOp[]; snapshot?: Snapshot };
        if (!m.ops?.length && !m.snapshot) return;
        cursor = Math.max(cursor, m.snapshot?.upTo ?? 0, ...(m.ops ?? []).map((o) => o.pos));
        on(m.ops ?? [], m.snapshot);
      });
      ws.addEventListener("close", () => void (stopped || setTimeout(connect, 2000)));
    };
    void connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }

  // Blobs ------------------------------------------------------------------------

  async putBlob(id: string, bytes: Uint8Array) {
    const go = async (fresh: boolean) =>
      this.f(`${this.origin}/e2ee/blob/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${await this.token(fresh)}` }, body: bytes as Uint8Array<ArrayBuffer> });
    let res = await go(false);
    if (res.status === 401 && this.o.device) res = await go(true);
    if (!res.ok) throw new RelayError(res.status, `PUT blob: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
  }

  async getBlob(id: string): Promise<Uint8Array> {
    const res = await this.f(`${this.origin}/e2ee/blob/${id}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new RelayError(res.status, `GET blob: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteBlob(id: string) {
    const res = await this.f(`${this.origin}/e2ee/blob/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new RelayError(res.status, `DELETE blob: ${res.status}`);
  }

  // Nodes ------------------------------------------------------------------------

  nodes() {
    return this.authed<Nodes>("GET", "/e2ee/nodes");
  }

  setLeader(device: string | null) {
    return this.authed<Nodes>("PUT", "/e2ee/nodes/leader", { device });
  }

  // This device as one of the account's nodes: the tunnel's requests are
  // answered by handler, at the node's own paths (/mcp, not /n/<handle>/mcp)
  // on a placeholder host, so the handler must know its public origin
  // (nodes().url). Reconnects after a drop until stopped, or until another
  // socket of this device's replaces it.
  serveTunnel(handler: (req: Request) => Promise<Response>, o: { name?: string; onState?(connected: boolean): void } = {}): () => void {
    let stopped = false;
    let ws: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const make = this.o.socket ?? ((url, protocols) => new WebSocket(url, protocols));
    const answer = async (r: TunnelRequest): Promise<TunnelResponse> => {
      try {
        const res = await handler(new Request(`http://tunnel.invalid${r.path}`, { method: r.method, headers: r.headers, body: r.body && !/^(GET|HEAD)$/.test(r.method) ? (fromB64url(r.body) as Uint8Array<ArrayBuffer>) : undefined }));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > LIMITS.tunnel) return { id: r.id, status: 502, headers: [["content-type", "application/json"]], body: b64url(utf8(JSON.stringify({ error: "the answer is too big for the tunnel" }))) };
        return { id: r.id, status: res.status, headers: [...res.headers] as [string, string][], ...(bytes.length && { body: b64url(bytes) }) };
      } catch (e) {
        return { id: r.id, status: 500, headers: [["content-type", "application/json"]], body: b64url(utf8(JSON.stringify({ error: (e as Error).message }))) };
      }
    };
    const connect = async () => {
      if (stopped) return;
      const t = await this.token().catch(() => undefined);
      if (!t) return void setTimeout(connect, 5000);
      const sock = (ws = make(`${this.origin.replace(/^http/, "ws")}/e2ee/nodes/live${o.name ? `?name=${encodeURIComponent(o.name)}` : ""}`, ["corkboard", `corkboard.bearer.${b64url(utf8(t))}`]));
      sock.addEventListener("open", () => {
        o.onState?.(true);
        ping = setInterval(() => sock.readyState === 1 && sock.send("ping"), 30_000);
      });
      sock.addEventListener("message", (e: MessageEvent) => {
        if (e.data === "pong") return;
        let r: TunnelRequest;
        try {
          r = JSON.parse(String(e.data)) as TunnelRequest;
        } catch {
          return;
        }
        void answer(r).then((a) => sock.readyState === 1 && sock.send(JSON.stringify(a)));
      });
      sock.addEventListener("close", (e: CloseEvent) => {
        if (ping) clearInterval(ping);
        o.onState?.(false);
        if (!stopped && e.code !== 4000) setTimeout(connect, 2000);
      });
    };
    void connect();
    return () => {
      stopped = true;
      if (ping) clearInterval(ping);
      ws?.close();
    };
  }
}
