// The talk with the Worker behind Neovim's cloud ops (cards/cloud.lua):
// Neovim asks for cards, plans and the fleet, and this asks the Worker. Each
// board a session uses gets one live socket to the Worker, shared by every
// session on that board, whose events go to every listener; when it drops it
// reconnects and sends a whole fresh copy, so nothing missed is lost.
//
// Only fetch and WebSocket, so it runs where Neovim's requests are answered:
// the bridge (boards.ts), or a page with no machine (web/src/nvim/wasm/rpc.ts).
// What differs between the two comes in a Link.

export type Link = {
  // The Worker's origin, and a current token for it.
  cloud: string;
  token(): Promise<string>;
  // A WebSocket to the Worker, signed in with token.
  socket(url: string, token: string): WebSocket;
  // The environment this is, as fleetd names it (fleet/fleetd/queue.ts),
  // and a clone's remotes, as URLs another machine can clone from. A page
  // with no machine has neither, and its clone's place (in memory) is never
  // told to the Worker as the board's.
  environment: string | null;
  remotes(root: string): Promise<string[]>;
  // The fleet view's card for this machine, and this bridge's id at the
  // Worker; null and undefined where there's neither.
  machine(): unknown;
  self(): string | undefined;
  // A day plan accepted here (phone.ts), so the phone needn't say so again.
  acceptedHere?(stamp: string): void;
};

// key: the board's, or USER for the user's own socket (plans).
export type Listener = (key: string, event: unknown) => void;

// The user's socket, which tells of plan changes (GET /api/live).
export const USER = "@user";

// The Worker, by way of a Link, and the boards followed there.
export class Cloud {
  // Each board followed, with whoever follows it.
  live = new Map<string, Live>();

  constructor(readonly link: Link) {}

  async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.link.cloud}/api/boards${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.link.token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async ok(method: string, path: string, body?: unknown) {
    const { status, json } = await this.api(method, path, body);
    if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
    return json;
  }

  snapshot = (key: string) => this.ok("GET", `/${encodeURIComponent(key)}/cards?log=1`);

  async follow(key: string, listener: Listener) {
    let l = this.live.get(key);
    if (!l) {
      l = new Live(this, key);
      this.live.set(key, l);
      try {
        await l.open();
      } catch (e) {
        this.live.delete(key);
        throw e;
      }
    }
    l.listeners.add(listener);
  }
}

class Live {
  listeners = new Set<Listener>();
  private ws?: WebSocket;
  private retry = 1000;
  private closed = false;
  private ping?: ReturnType<typeof setInterval>;

  constructor(
    private cloud: Cloud,
    readonly key: string,
  ) {}

  // Resolves once the socket is open, so a copy fetched after it misses
  // nothing.
  async open(): Promise<void> {
    const path = this.key === USER ? "/api/live" : `/api/boards/${encodeURIComponent(this.key)}/live`;
    const ws = this.cloud.link.socket(`${this.cloud.link.cloud.replace(/^http/, "ws")}${path}`, await this.cloud.link.token());
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
      const event = this.key === USER ? { type: "reconnected" } : { type: "snapshot", cards: await this.cloud.snapshot(this.key) };
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

// A Neovim session's view of the cloud: what it follows, so closing the
// session stops its sockets once nobody else uses them.
export class Session {
  private keys = new Set<string>();
  // The conversations it follows (fleet_follow), by "bridge/key".
  private conversations = new Map<string, WebSocket>();
  // sessions: the fleet view's (away.ts's list, for this Neovim's page).
  constructor(
    private cloud: Cloud,
    private listener: Listener,
    private sessions: () => unknown[] = () => [],
  ) {}

  // op and args as cards/cloud.lua sends them.
  async call(op: string, args: any[]): Promise<unknown> {
    if (op.startsWith("plan_")) return this.plan(op, args);
    if (op.startsWith("fleet_")) return this.fleet(op, args);
    // Pepper's session (plan/claude.lua): the one token that sees the goals.
    if (op === "pepper_token") {
      const res = await fetch(`${this.cloud.link.cloud}/api/tokens/pepper`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return { ...json, url: `${this.cloud.link.cloud}/mcp` };
    }
    // Another brain's VM (fleet.lua's open_vm): its sessions' MCP and memory.
    if (op === "brain_token") {
      const [brain] = args;
      const res = await fetch(`${this.cloud.link.cloud}/api/tokens/brain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ brain }),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return { ...json, url: `${this.cloud.link.cloud}/mcp` };
    }
    // A note, or null when there is none: Pepper's recommendations (usage.lua).
    if (op === "note_get") {
      const [id] = args;
      const res = await fetch(`${this.cloud.link.cloud}/api/notes/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${await this.cloud.link.token()}` } });
      if (res.status === 404) return null;
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return json;
    }
    // A note, made or replaced: the usage report Pepper reads (usage.lua).
    if (op === "note_put") {
      const [id, note] = args;
      const res = await fetch(`${this.cloud.link.cloud}/api/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify(note),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return null;
    }
    // The goals, read out of Pepper's goal notes: the day plan's goals box.
    if (op === "goals") {
      const res = await fetch(`${this.cloud.link.cloud}/api/goals`, { headers: { Authorization: `Bearer ${await this.cloud.link.token()}` } });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return json;
    }
    // The board of the project with this first commit: the one made at this
    // path, if it's among them (a fork beside its upstream), or the first.
    // Otherwise the path's own key, for a board made here.
    if (op === "resolve") {
      const [pathKey, commit] = args;
      // Filtered here too: a Worker from before commits lists every board.
      const listed = (await this.cloud.ok("GET", `?commit=${encodeURIComponent(commit)}`)) as { key: string; commit?: string }[];
      const found = listed.filter((b) => b.commit === commit);
      return (found.find((b) => b.key === pathKey) ?? found[0])?.key ?? pathKey;
    }
    // Every board, with its project's root and remotes: Open project (picker.lua).
    if (op === "boards") return this.cloud.ok("GET", "");
    const [key] = args;
    if (typeof key !== "string" || !key) throw new Error("corkboard cloud: no board key");
    const board = `/${encodeURIComponent(key)}`;
    switch (op) {
      // Follows the board and answers with a whole copy; null for a board
      // that doesn't exist yet, unless make, which makes it (a first card).
      // Opening corkboard somewhere doesn't make that a board. Opening one
      // tells the Worker its first commit, and where this machine's clone is,
      // and its remotes, which another machine clones it from (server.ts's /open).
      case "subscribe": {
        const [, name, here, make, commit] = args;
        const root = this.cloud.link.environment === null ? null : here;
        const found = root ? await this.cloud.link.remotes(root) : [];
        const place = { root: root ?? null, environment: this.cloud.link.environment, ...(commit && { commit }), ...(found.length && { remotes: found }) };
        if (make) await this.cloud.ok("PUT", board, { name, ...place });
        else if ((await this.cloud.api("GET", `${board}/cards`)).status === 404) return null;
        else if (root) await this.cloud.ok("PUT", board, place);
        await this.cloud.follow(key, this.listener);
        this.keys.add(key);
        return this.cloud.snapshot(key);
      }
      // A new project's board, made before it has a card (picker.lua).
      case "make": {
        const [, name, here] = args;
        const root = this.cloud.link.environment === null ? null : here;
        const found = root ? await this.cloud.link.remotes(root) : [];
        return this.cloud.ok("PUT", board, { name, root, environment: this.cloud.link.environment, ...(found.length && { remotes: found }) });
      }
      case "create":
        return this.cloud.ok("POST", `${board}/cards`, args[1]);
      // A stale version isn't an error: the answer carries the card as it is
      // now, for the change to be made again on.
      case "update": {
        const [, id, version, fields] = args;
        const { status, json } = await this.cloud.api("PATCH", `${board}/cards/${id}`, { version, ...fields });
        if (status === 409) return { conflict: json.card };
        if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
        return { card: json };
      }
      case "log": {
        const [, id, who, note] = args;
        return this.cloud.ok("POST", `${board}/cards/${id}/log`, { who, note });
      }
      // Off the board, kept; or gone for good.
      case "archive":
        return this.cloud.ok("POST", `${board}/cards/${args[1]}/archive`, {});
      case "delete": {
        const { status, json } = await this.cloud.api("DELETE", `${board}/cards/${args[1]}`);
        if (status >= 400) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${status}`}`);
        return null;
      }
      // The card's agent is still running here: its claim holds.
      case "touch": {
        const [, id, agent] = args;
        return this.cloud.ok("POST", `${board}/cards/${id}/lease`, { agent });
      }
      // A token for one agent on one card, and where to use it.
      case "token": {
        const [, card, agent] = args;
        const res = await fetch(`${this.cloud.link.cloud}/api/tokens`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ board: key, card, agent }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
        return { ...json, url: `${this.cloud.link.cloud}/mcp` };
      }
      case "revoke": {
        const [, agentToken] = args;
        await fetch(`${this.cloud.link.cloud}/api/tokens/revoke`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ token: agentToken }),
        });
        return null;
      }
      default:
        throw new Error(`corkboard cloud: no operation ${op}`);
    }
  }

  // The fleet view (fleet.lua): each environment and what runs there, the
  // spawns not over yet and the last few that are, the Claude Code sessions
  // of every page this bridge has open (away.ts tells it of changes in
  // those) and the machine and environment the bridge is on, and the user's
  // socket, which says when the rest changes.
  private async fleet(op: string, args: any[]): Promise<unknown> {
    const send = async (method: string, path: string, body: object = {}) => {
      const res = await fetch(`${this.cloud.link.cloud}/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
      return json;
    };
    switch (op) {
      case "fleet_subscribe":
        await this.cloud.follow(USER, this.listener);
        this.keys.add(USER);
        return null;
      case "fleet_get": {
        const [environments, open, over] = await Promise.all([
          send("GET", "/fleet/environments"),
          send("GET", "/spawns?state=pending-approval,queued,running&limit=50"),
          send("GET", "/spawns?state=done,failed,stopped&limit=8"),
        ]);
        // Every other bridge's sessions, and fleetd's: this one's are sessions.
        const bridges = ((await send("GET", "/sessions").catch(() => [])) as { id: string }[]).filter((b) => b.id !== this.cloud.link.self());
        return { environments, spawns: [...open, ...over], sessions: this.sessions(), bridges, self: this.cloud.link.self() ?? null, machine: this.cloud.link.machine() };
      }
      // A session's conversation, as it goes, to the fleet view
      // (corkboard/conversation.lua) as { type: "conversation", bridge, key,
      // items, reset } and, once it's over, { type: "conversation_end", why }.
      case "fleet_follow": {
        const [bridge, key] = args as [string, string];
        const id = `${bridge}/${key}`;
        if (!/^[\w-]{1,64}\/[\w.-]{1,64}$/.test(id)) throw new Error("corkboard cloud: which session?");
        this.conversations.get(id)?.close();
        const ws = this.cloud.link.socket(`${this.cloud.link.cloud.replace(/^http/, "ws")}/api/sessions/${id}/attach`, await this.cloud.link.token());
        this.conversations.set(id, ws);
        ws.onmessage = (e) => {
          let m: any;
          try {
            m = JSON.parse(String(e.data));
          } catch {
            return;
          }
          if (m.type === "out") {
            const batch = JSON.parse(m.data);
            this.listener(USER, { type: "conversation", bridge, key, items: batch.items ?? [], reset: !!batch.reset });
          } else if (m.type === "end") this.listener(USER, { type: "conversation_end", bridge, key, why: m.why ?? "ended" });
        };
        ws.onclose = () => {
          if (this.conversations.get(id) !== ws) return;
          this.conversations.delete(id);
          this.listener(USER, { type: "conversation_end", bridge, key, why: "no longer followed" });
        };
        return null;
      }
      case "fleet_unfollow": {
        const id = `${args[0]}/${args[1]}`;
        const ws = this.conversations.get(id);
        this.conversations.delete(id);
        ws?.close();
        return null;
      }
      // Typed into a session: text, then keys (enter, esc, …).
      case "fleet_say": {
        const [bridge, key, text, keys] = args as [string, string, string, string[]];
        const res = await fetch(`${this.cloud.link.cloud}/api/sessions/${encodeURIComponent(bridge)}/${encodeURIComponent(key)}/say`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: text ?? "", keys: keys ?? [] }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(`corkboard cloud: ${json.error ?? `HTTP ${res.status}`}`);
        return null;
      }
      // A session you talk to, in one of an environment's slots: on a
      // board's project (its clone there), when one is named.
      case "fleet_session": {
        const [environment, template, board] = args as [string, string, string?];
        return send("POST", "/spawns", { environment, template, interactive: true, task: "", ...(board && { board }) });
      }
      case "fleet_approve":
      case "fleet_stop":
        return send("POST", `/spawns/${encodeURIComponent(args[0])}/${op === "fleet_approve" ? "approve" : "stop"}`);
      default:
        throw new Error(`corkboard cloud: no operation ${op}`);
    }
  }

  // The day plan (plan.lua): its date's plan, and the user's socket for
  // its changes. A stale version answers with the plan as it is now.
  private async plan(op: string, args: any[]): Promise<unknown> {
    if (op === "plan_subscribe") {
      await this.cloud.follow(USER, this.listener);
      this.keys.add(USER);
      return null;
    }
    // The boards, so a block's card can be opened in its project's window.
    if (op === "plan_boards") return this.cloud.ok("GET", "");
    const [date, ...rest] = args;
    if (typeof date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error("corkboard cloud: plans need a YYYY-MM-DD date");
    const path = `${this.cloud.link.cloud}/api/plans/${date}`;
    const send = async (method: string, sub: string, body?: unknown) => {
      const res = await fetch(`${path}${sub}`, {
        method,
        headers: { Authorization: `Bearer ${await this.cloud.link.token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
      case "plan_accept": {
        // plan.lua wrote the calendar before asking, so phone.ts needn't.
        const res = await send("POST", "/accept", { version: rest[0], blocks: rest[1] });
        if (res.plan?.accepted) this.cloud.link.acceptedHere?.(res.plan.accepted);
        return res;
      }
      case "plan_discard":
        return send("POST", "/discard", { version: rest[0] });
      case "plan_day":
        return send("PUT", "/day", { version: rest[0], blocks: rest[1] });
      default:
        throw new Error(`corkboard cloud: no operation ${op}`);
    }
  }

  close() {
    for (const ws of this.conversations.values()) ws.close();
    this.conversations.clear();
    for (const key of this.keys) {
      const l = this.cloud.live.get(key);
      if (!l) continue;
      l.listeners.delete(this.listener);
      if (!l.listeners.size) {
        l.close();
        this.cloud.live.delete(key);
      }
    }
  }
}
