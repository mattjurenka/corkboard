// An account's nodes, one object per account (named by its handle,
// wire.ts's nodeHandle): each device's socket while it's connected
// (routes.ts checked its token and says which device, as X-Device, and the
// name the node gives it, as X-Device-Name), every device that has, the
// leader the user chose, and the tunnel: a request to <relay>/n/<handle>/…
// goes to the leader if it's connected, else to the node that connected
// last, and its answer comes back. See .agent/plans/local-memory.md, step 8.
//
// What goes through the tunnel is the node's own HTTP (OAuth, /mcp, the
// phone's API): it's plaintext here in passing, and nothing of it is kept.

import { DurableObject } from "cloudflare:workers";
import { LIMITS, type NodesView, type TunnelRequest, type TunnelResponse } from "../../lib/e2ee/wire";

type Attached = { device: string; since: number };

export class Nodes extends DurableObject {
  private sql: SqlStorage;
  // Requests sent to a node and not yet answered. A request in flight keeps
  // the object awake, so this outlives no hibernation that matters.
  private pending = new Map<string, { ws: WebSocket; done: (r: TunnelResponse | undefined) => void }>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS devices (device TEXT PRIMARY KEY, name TEXT NOT NULL, seen INTEGER NOT NULL)");
    // A node's keepalive, answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private leader(): string | null {
    return (this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'leader'").toArray()[0]?.v as string | undefined) ?? null;
  }

  setLeader(device: string | null): NodesView {
    if (device) this.sql.exec("INSERT INTO meta (k, v) VALUES ('leader', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", device);
    else this.sql.exec("DELETE FROM meta WHERE k = 'leader'");
    return this.status();
  }

  private sockets(): { ws: WebSocket; a: Attached }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const a = ws.deserializeAttachment() as Attached | null;
      return a && ws.readyState === WebSocket.OPEN ? [{ ws, a }] : [];
    });
  }

  status(): NodesView {
    const known = this.sql.exec<{ device: string; name: string; seen: number }>("SELECT device, name, seen FROM devices ORDER BY seen DESC").toArray();
    return { leader: this.leader(), connected: this.sockets().map(({ a }) => ({ device: a.device, since: a.since })), known };
  }

  // The node a request goes to: the leader, or the newest.
  private target(): WebSocket | undefined {
    const all = this.sockets();
    const leader = this.leader();
    return (all.find(({ a }) => a.device === leader) ?? all.sort((x, y) => y.a.since - x.a.since)[0])?.ws;
  }

  // The node's answer, or undefined when no node is connected, it went
  // away, or it took longer than LIMITS.tunnelMs ({ timeout } says which).
  async forward(req: TunnelRequest): Promise<TunnelResponse | { none: true } | { timeout: true }> {
    const ws = this.target();
    if (!ws) return { none: true };
    const answer = new Promise<TunnelResponse | undefined>((done) => this.pending.set(req.id, { ws, done }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), LIMITS.tunnelMs)));
    try {
      ws.send(JSON.stringify(req));
    } catch {
      this.pending.delete(req.id);
      return { none: true };
    }
    const r = await Promise.race([answer, late]);
    clearTimeout(timer!);
    this.pending.delete(req.id);
    if (r === "late") return { timeout: true };
    return r ?? { none: true };
  }

  // A node's socket. A device has one: a newer one replaces the old.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const device = request.headers.get("X-Device");
    if (!device) return new Response("no device", { status: 400 });
    for (const { ws, a } of this.sockets()) if (a.device === device) this.drop(ws, 4000, "replaced");
    const name = request.headers.get("X-Device-Name") || device.slice(0, 8);
    this.sql.exec("INSERT INTO devices (device, name, seen) VALUES (?, ?, ?) ON CONFLICT (device) DO UPDATE SET name = excluded.name, seen = excluded.seen", device, name, Date.now());
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [device]);
    server.serializeAttachment({ device, since: Date.now() } satisfies Attached);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > LIMITS.tunnel * 1.4) return;
    let r: TunnelResponse;
    try {
      r = JSON.parse(message) as TunnelResponse;
    } catch {
      return;
    }
    const p = typeof r?.id === "string" ? this.pending.get(r.id) : undefined;
    // Only the node it was sent to answers it.
    if (p?.ws === ws) p.done(r);
  }

  private drop(ws: WebSocket, code: number, reason = "") {
    for (const [, p] of this.pending) if (p.ws === ws) p.done(undefined);
    try {
      ws.close(code, reason);
    } catch {}
  }

  webSocketClose(ws: WebSocket, code: number) {
    const a = ws.deserializeAttachment() as Attached | null;
    if (a) this.sql.exec("UPDATE devices SET seen = ? WHERE device = ?", Date.now(), a.device);
    this.drop(ws, code === 1005 ? 1000 : code);
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws, 1011);
  }
}
