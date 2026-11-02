// The relay's API, as a client calls it (cloud/src/e2ee.ts serves it):
//
//   POST /e2ee/accounts           { creation, cert }: a new account, with an invite
//                                 (or /api/e2ee/accounts, an admin's Google token, without)
//   POST /e2ee/challenge          { account, device }: { nonce, expires }
//   POST /e2ee/token              { cert, answer }: { token, expires }
//   POST /e2ee/revoke             { revocation }: the account key's own signature is the auth
//   GET  /e2ee/revoked            the account's revocations, for its devices to check
//   /e2ee/pair...                 pairing mailboxes (pairing.ts)
//   POST /e2ee/log/:object        { ops: NewOp[] }: { ops: [{ id, pos }] }
//   GET  /e2ee/log/:object        ?since=&limit=: { ops: WireOp[], head }
//   GET  /e2ee/log/:object/live   WebSocket, ?since=: { ops } messages, catch-up first
//   PUT  /e2ee/blob/:id           an encrypted attachment; GET it back
//
// Everything but accounts, challenges, revocations and the new device's
// side of pairing wants a token from /e2ee/token, as a bearer (or, for a
// browser's socket, the corkboard.bearer.<base64url> subprotocol). A token
// that's expired or refused is got again, once, from the device's keys.

import { answer, type Device } from "./device";
import type { Delivery, MailboxView, PairTransport } from "./pairing";
import type { LogTransport } from "./sync";
import type { Creation, DeviceCert, NewOp, Revocation, Signed, WireOp } from "./wire";
import { b64url, utf8 } from "./wire";

export type Token = { token: string; expires: number };

// fetch as the relay is called with it: a test's Worker, or the real one.
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

  get account() {
    return this.o.cert?.body.account;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.origin}${path}`, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new RelayError(res.status, `${method} ${path}: ${json.error ?? res.status}`);
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

  // Logs -------------------------------------------------------------------------

  async append(object: string, ops: NewOp[]) {
    return (await this.authed<{ ops: { id: string; pos: number }[] }>("POST", `/e2ee/log/${object}`, { ops })).ops;
  }

  read(object: string, since: number, limit?: number) {
    return this.authed<{ ops: WireOp[]; head: number }>("GET", `/e2ee/log/${object}?since=${since}${limit ? `&limit=${limit}` : ""}`);
  }

  // Reconnects after a drop, from the last op it saw, until stopped.
  subscribe(object: string, since: number, on: (ops: WireOp[]) => void): () => void {
    let stopped = false;
    let ws: WebSocket | undefined;
    let cursor = since;
    const make = this.o.socket ?? ((url, protocols) => new WebSocket(url, protocols));
    const connect = async () => {
      if (stopped) return;
      const t = await this.token().catch(() => undefined);
      if (!t) return void setTimeout(connect, 5000);
      const url = `${this.origin.replace(/^http/, "ws")}/e2ee/log/${object}/live?since=${cursor}`;
      ws = make(url, ["corkboard", `corkboard.bearer.${b64url(utf8(t))}`]);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { ops?: WireOp[] };
        if (!m.ops?.length) return;
        cursor = Math.max(cursor, ...m.ops.map((o) => o.pos));
        on(m.ops);
      };
      ws.onclose = () => void (stopped || setTimeout(connect, 2000));
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
}
