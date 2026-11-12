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
//
// Channels (lib/e2ee/channel.ts) come through here too: another device's
// socket to /e2ee/channel?to=<device>, paired with that device's node
// socket, its messages passed on both ways (wire.ts's CHANNEL). They're
// sealed between the two devices, so all this sees is their size.

import { DurableObject } from "cloudflare:workers";
import { CHANNEL, CHANNEL_ID, LIMITS, type NodesView, type TunnelRequest, type TunnelResponse, b64url, concat, fromB64url } from "../../lib/e2ee/wire";

// tunnel: false, a socket that answers channels only (?tunnel=0).
type Attached = { device: string; since: number; tunnel?: false };
// An opener's socket: the channel's id, who opened it, and the node socket
// (device and since) it's paired with.
type Opener = { channel: string; from: string; to: string; since: number };

const isOpener = (a: Attached | Opener | null): a is Opener => !!a && "channel" in a;
const utf8 = (s: string) => new TextEncoder().encode(s);
// A close's reason is at most 123 bytes.
const why = (reason: string) => reason.slice(0, 120);

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
    this.tell();
    return this.status();
  }

  // Forgejo's web pages through the tunnel (/n/<handle>/forge/), which the
  // user turns on: a browser's session with the forge then passes here.
  forgeWeb(): boolean {
    return this.sql.exec("SELECT 1 FROM meta WHERE k = 'forge'").toArray().length > 0;
  }

  setForgeWeb(on: boolean): NodesView {
    if (on) this.sql.exec("INSERT INTO meta (k, v) VALUES ('forge', '1') ON CONFLICT (k) DO NOTHING");
    else this.sql.exec("DELETE FROM meta WHERE k = 'forge'");
    return this.status();
  }

  // Every node socket told which node the tunnel goes to now ("leader <device>",
  // or "leader -" with none), so a node knows at once whether it leads and
  // fleetd moves its channel, rather than waiting on their next look. Not
  // JSON, so a node from before this drops it.
  private tell(except?: WebSocket) {
    const to = this.target(except);
    const said = `leader ${(to?.deserializeAttachment() as Attached | undefined)?.device ?? "-"}`;
    for (const { ws } of this.sockets()) {
      if (ws === except) continue;
      try {
        ws.send(said);
      } catch {}
    }
  }

  private sockets(): { ws: WebSocket; a: Attached }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const a = ws.deserializeAttachment() as Attached | Opener | null;
      return a && !isOpener(a) && ws.readyState === WebSocket.OPEN ? [{ ws, a }] : [];
    });
  }

  // The openers' sockets paired with a node socket.
  private openers(device: string, since: number, channel?: string): { ws: WebSocket; o: Opener }[] {
    return this.ctx.getWebSockets(channel ? `ch:${channel}` : `to:${device}`).flatMap((ws) => {
      const o = ws.deserializeAttachment() as Attached | Opener | null;
      return isOpener(o) && o.to === device && o.since === since ? [{ ws, o }] : [];
    });
  }

  private static frame(kind: number, channel: string, payload: Uint8Array) {
    return concat(Uint8Array.of(kind), fromB64url(channel), payload);
  }

  // Another device's channel to one of the account's connected devices.
  private openChannel(from: string, to: string): Response {
    const node = this.sockets().find(({ a }) => a.device === to);
    if (!node) return Response.json({ error: "that device isn't connected" }, { status: 404 });
    const channel = b64url(crypto.getRandomValues(new Uint8Array(CHANNEL_ID)));
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [`ch:${channel}`, `to:${to}`]);
    server.serializeAttachment({ channel, from, to, since: node.a.since } satisfies Opener);
    node.ws.send(Nodes.frame(CHANNEL.open, channel, utf8(JSON.stringify({ from }))));
    return new Response(null, { status: 101, webSocket: client });
  }

  status(): NodesView {
    const known = this.sql.exec<{ device: string; name: string; seen: number }>("SELECT device, name, seen FROM devices ORDER BY seen DESC").toArray();
    return { leader: this.leader(), ...(this.forgeWeb() && { forge: true as const }), connected: this.sockets().map(({ a }) => ({ device: a.device, since: a.since, ...(a.tunnel === false && { tunnel: false as const }) })), known };
  }

  // The node a request goes to: the leader, or the newest.
  private target(except?: WebSocket): WebSocket | undefined {
    const all = this.sockets().filter(({ ws, a }) => a.tunnel !== false && ws !== except);
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
    const to = request.headers.get("X-Channel-To");
    if (to) return this.openChannel(device, to);
    for (const { ws, a } of this.sockets()) if (a.device === device) this.drop(ws, 4000, "replaced");
    const name = request.headers.get("X-Device-Name") || device.slice(0, 8);
    this.sql.exec("INSERT INTO devices (device, name, seen) VALUES (?, ?, ?) ON CONFLICT (device) DO UPDATE SET name = excluded.name, seen = excluded.seen", device, name, Date.now());
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [device]);
    server.serializeAttachment({ device, since: Date.now(), ...(request.headers.get("X-Tunnel") === "0" && { tunnel: false as const }) } satisfies Attached);
    this.tell();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Attached | Opener | null;
    if (isOpener(a)) return this.fromOpener(ws, a, message);
    if (typeof message !== "string") {
      if (a) this.fromNode(a, new Uint8Array(message));
      return;
    }
    if (message.length > LIMITS.tunnel * 1.4) return;
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

  // An opener's message, to the node it's paired with.
  private fromOpener(ws: WebSocket, o: Opener, message: string | ArrayBuffer) {
    if (typeof message === "string" || message.byteLength > LIMITS.channelMessage) return this.close(ws, 1009, "a channel carries binary messages, each at most " + LIMITS.channelMessage + " bytes");
    const node = this.sockets().find(({ a }) => a.device === o.to && a.since === o.since);
    if (!node) return this.close(ws, 1001, "the device went away");
    node.ws.send(Nodes.frame(CHANNEL.message, o.channel, new Uint8Array(message)));
  }

  // A node's message on one of its channels, to its opener.
  private fromNode(a: Attached, b: Uint8Array) {
    if (b.length < 1 + CHANNEL_ID || b.length > LIMITS.channelMessage + 1 + CHANNEL_ID) return;
    const channel = b64url(b.subarray(1, 1 + CHANNEL_ID));
    const payload = b.subarray(1 + CHANNEL_ID);
    for (const { ws } of this.openers(a.device, a.since, channel)) {
      if (b[0] === CHANNEL.message) ws.send(payload);
      else if (b[0] === CHANNEL.close) this.close(ws, 1000, new TextDecoder().decode(payload));
    }
  }

  private close(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, why(reason));
    } catch {}
  }

  private drop(ws: WebSocket, code: number, reason = "") {
    for (const [, p] of this.pending) if (p.ws === ws) p.done(undefined);
    const a = ws.deserializeAttachment() as Attached | Opener | null;
    if (a && !isOpener(a)) for (const o of this.openers(a.device, a.since)) this.close(o.ws, 1001, "the device went away");
    try {
      ws.close(code, reason);
    } catch {}
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    const a = ws.deserializeAttachment() as Attached | Opener | null;
    if (isOpener(a)) {
      // The opener gone: its channel's end, to the node.
      this.sockets()
        .find(({ a: n }) => n.device === a.to && n.since === a.since)
        ?.ws.send(Nodes.frame(CHANNEL.close, a.channel, utf8(why(reason || "the other side went away"))));
      return this.close(ws, code === 1005 ? 1000 : code, reason);
    }
    if (a) this.sql.exec("UPDATE devices SET seen = ? WHERE device = ?", Date.now(), a.device);
    this.drop(ws, code === 1005 ? 1000 : code);
    if (a) this.tell(ws);
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws, 1011, "");
  }
}
