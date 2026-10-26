// The bridge's half of cloud boards: Neovim asks it for cards, and it asks
// the Worker. Neovim's requests come in on its RPC channel as the
// notification rpcnotify(chan, "corkboard.cloud", id, op, ...args); the
// bridge answers each with nvim_exec_lua of corkboard.cards.cloud.answer
// { id, error?, result? }, instead of passing them to the page (see
// server.ts's pump, and cards/cloud.lua for why not rpcrequest).
//
// Each board a session uses gets one live socket to the Worker, shared by
// every session on that board. Each event it brings is forwarded to every
// subscribed Neovim as nvim_exec_lua of corkboard.cards.cloud_event, so a
// change made anywhere (another machine, an agent, the API) shows at once.
// When the socket drops it reconnects and sends a whole fresh copy, so
// nothing missed in between is lost.

import { CLOUD, token } from "./cloud";

// key: the board's, or USER for the user's own socket (plans).
export type Listener = (key: string, event: unknown) => void;

// The user's socket, which tells of plan changes (GET /api/live).
export const USER = "@user";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${CLOUD}/api/boards${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function ok(method: string, path: string, body?: unknown) {
  const { status, json } = await api(method, path, body);
  if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
  return json;
}

const snapshot = (key: string) => ok("GET", `/${encodeURIComponent(key)}/cards?log=1`);

class Live {
  listeners = new Set<Listener>();
  private ws?: WebSocket;
  private retry = 1000;
  private closed = false;
  private ping?: ReturnType<typeof setInterval>;

  constructor(readonly key: string) {}

  // Resolves once the socket is open, so a copy fetched after it misses
  // nothing.
  async open(): Promise<void> {
    const path = this.key === USER ? "/api/live" : `/api/boards/${encodeURIComponent(this.key)}/live`;
    const url = `${CLOUD.replace(/^http/, "ws")}${path}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${await token()}` } } as any);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`corkboard cloud: can't follow board ${this.key}`));
    });
    this.retry = 1000;
    // Hibernation answers these without waking the board; they keep idle
    // proxies from dropping the socket.
    this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const event = JSON.parse(String(e.data));
      for (const l of this.listeners) l(this.key, event);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (!this.closed) setTimeout(() => this.reconnect(), this.retry);
    };
  }

  private async reconnect() {
    if (this.closed) return;
    try {
      await this.open();
      // What was missed: a board's whole copy; for plans, just that the
      // socket was gone, so whoever shows one reads it again.
      const event = this.key === USER ? { type: "reconnected" } : { type: "snapshot", cards: await snapshot(this.key) };
      for (const l of this.listeners) l(this.key, event);
    } catch (e) {
      console.error((e as Error).message);
      this.retry = Math.min(this.retry * 2, 60_000);
      setTimeout(() => this.reconnect(), this.retry);
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.ws?.close();
  }
}

const live = new Map<string, Live>();

async function follow(key: string, listener: Listener) {
  let l = live.get(key);
  if (!l) {
    l = new Live(key);
    live.set(key, l);
    try {
      await l.open();
    } catch (e) {
      live.delete(key);
      throw e;
    }
  }
  l.listeners.add(listener);
}

// A Neovim session's view of the cloud: what it follows, so closing the
// session stops its sockets once nobody else uses them.
export class Session {
  private keys = new Set<string>();
  constructor(private listener: Listener) {}

  // op and args as cards/cloud.lua sends them.
  async call(op: string, args: any[]): Promise<unknown> {
    if (op.startsWith("plan_")) return this.plan(op, args);
    // Pepper's session (plan/claude.lua): the one token that sees the goals.
    if (op === "pepper_token") {
      const res = await fetch(`${CLOUD}/api/tokens/pepper`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return { ...json, url: `${CLOUD}/mcp` };
    }
    // A note, or null when there is none: Pepper's recommendations (usage.lua).
    if (op === "note_get") {
      const [id] = args;
      const res = await fetch(`${CLOUD}/api/notes/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (res.status === 404) return null;
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return json;
    }
    // A note, made or replaced: the usage report Pepper reads (usage.lua).
    if (op === "note_put") {
      const [id, note] = args;
      const res = await fetch(`${CLOUD}/api/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify(note),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return null;
    }
    const [key] = args;
    if (typeof key !== "string" || !key) throw new Error("corkboard cloud: no board key");
    const board = `/${encodeURIComponent(key)}`;
    switch (op) {
      // Follows the board and answers with a whole copy; null for a board
      // that doesn't exist yet, unless make, which makes it (a first card).
      // Opening corkboard somewhere doesn't make that a board.
      case "subscribe": {
        const [, name, root, make] = args;
        if (make) await ok("PUT", board, { name, root: root ?? null });
        else if ((await api("GET", `${board}/cards`)).status === 404) return null;
        await follow(key, this.listener);
        this.keys.add(key);
        return snapshot(key);
      }
      case "create":
        return ok("POST", `${board}/cards`, args[1]);
      // A stale version isn't an error: the answer carries the card as it is
      // now, for the change to be made again on.
      case "update": {
        const [, id, version, fields] = args;
        const { status, json } = await api("PATCH", `${board}/cards/${id}`, { version, ...fields });
        if (status === 409) return { conflict: json.card };
        if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
        return { card: json };
      }
      case "log": {
        const [, id, who, note] = args;
        return ok("POST", `${board}/cards/${id}/log`, { who, note });
      }
      // Off the board, kept; or gone for good.
      case "archive":
        return ok("POST", `${board}/cards/${args[1]}/archive`, {});
      case "delete": {
        const { status, json } = await api("DELETE", `${board}/cards/${args[1]}`);
        if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
        return null;
      }
      // The card's agent is still running here: its claim holds.
      case "touch": {
        const [, id, agent] = args;
        return ok("POST", `${board}/cards/${id}/lease`, { agent });
      }
      // A token for one agent on one card, and where to use it.
      case "token": {
        const [, card, agent] = args;
        const res = await fetch(`${CLOUD}/api/tokens`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ board: key, card, agent }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
        return { ...json, url: `${CLOUD}/mcp` };
      }
      case "revoke": {
        const [, agentToken] = args;
        await fetch(`${CLOUD}/api/tokens/revoke`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ token: agentToken }),
        });
        return null;
      }
      default:
        throw new Error(`corkboard cloud: no operation ${op}`);
    }
  }

  // The day plan (plan.lua): its date's plan, and the user's socket for
  // its changes. A stale version answers with the plan as it is now.
  private async plan(op: string, args: any[]): Promise<unknown> {
    if (op === "plan_subscribe") {
      await follow(USER, this.listener);
      this.keys.add(USER);
      return null;
    }
    // The boards, so a block's card can be opened in its project's window.
    if (op === "plan_boards") return ok("GET", "");
    const [date, ...rest] = args;
    if (typeof date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error("corkboard cloud: plans need a YYYY-MM-DD date");
    const path = `${CLOUD}/api/plans/${date}`;
    const send = async (method: string, sub: string, body?: unknown) => {
      const res = await fetch(`${path}${sub}`, {
        method,
        headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status === 409) return { conflict: json.plan };
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return { plan: json };
    };
    switch (op) {
      case "plan_get":
        return (await send("GET", "")).plan;
      case "plan_say":
        return send("POST", "/say", { text: rest[0] });
      case "plan_accept":
        return send("POST", "/accept", { version: rest[0], blocks: rest[1] });
      case "plan_discard":
        return send("POST", "/discard", { version: rest[0] });
      case "plan_day":
        return send("PUT", "/day", { version: rest[0], blocks: rest[1] });
      default:
        throw new Error(`corkboard cloud: no operation ${op}`);
    }
  }

  close() {
    for (const key of this.keys) {
      const l = live.get(key);
      if (!l) continue;
      l.listeners.delete(this.listener);
      if (!l.listeners.size) {
        l.close();
        live.delete(key);
      }
    }
  }
}
