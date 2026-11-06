// The node the bridge runs itself (.agent/plans/local-memory.md, step 6),
// on loopback at a port of its own, so the app's memory is the encrypted
// brain on this machine: the Brains tab and its memory browser (brains_*,
// boards.ts), and every local session's hooks and memory tools (the
// environment server.ts gives Neovim).
//
// It runs when this machine is in an encrypted account, or isn't signed
// in, when it makes an account here (e2ee init --local's, its key in the
// keychain file; e2ee phrase shows its recovery phrase) with one brain,
// the Worker's starter. Signed in with no account, memory is the Worker's
// until it moves (step 7), and the node doesn't run.
//
// <state>/node/session-token is the sessions' bearer (an assistant's,
// minted once), and session-mcp.json their --mcp-config; owner-token is
// the user's own tools' on this machine (memory-sync.ts's); all 0600.
//
// The boards the node keeps are served here too (.agent/plans/local-boards.md,
// step 2): boards.ts sends a board's operations here when the Worker doesn't
// have it, and a change to one, from this machine or another device, comes
// back as the Worker's socket would tell it.
//
// The day plan is served here too (.agent/plans/local-plans.md, step 2):
// plan.lua's plan_* when the Worker has no plans (boards.ts decides), and
// each change to a plan or the chat as the Worker's user socket tells it.
//
// A second bridge on the machine (a --dev one beside the app's) finds the
// node running and uses it: the app's operations on its loopback /app, as
// the owner, its boards' events on /app/events, and the same files for its
// sessions.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedIn } from "../cloud";
import { localAccount } from "../e2ee";
import { Keystore } from "../keystore";
import { goals } from "../../lib/model/goals";
import type { BoardEvent, Card } from "../../lib/model/cards";
import { BRAIN_ONLY_KINDS, type Plan, blocks as checkBlocks, chatText, date as checkDate, note as checkNote, noteId } from "../../lib/model/plans";
import { type Data, type FullCard, Invalid, now } from "./data";
import { Conflict, type Message } from "./day";
import { DAY } from "./objects";
import { NODE_DIR, NodeRunning, type StartedNode, startNode } from "./serve";
import { touch } from "./leases";
import { joinHub } from "../hub";
import type { HubJoin, Link } from "../sessions";
import type { Reach } from "../peers";

const TOKEN_FILE = join(NODE_DIR, "session-token");
const MCP_FILE = join(NODE_DIR, "session-mcp.json");
export const OWNER_TOKEN_FILE = join(NODE_DIR, "owner-token");

// The Worker's STARTER (corkboard-cloud's brains.ts).
const STARTER = { title: "Pepper", description: "Your personal assistant.", account: null, credentials: [], abilities: ["chat"], persona: null, skin: null, default: true };
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FIELDS = ["title", "description", "account", "credentials", "abilities", "persona", "skin", "default"];

// The node as the bridge uses it, its own or another bridge's.
export type AppNode = {
  env: Record<string, string>;
  // A brains_* operation answered here, or undefined for the Worker's.
  brains(op: string, args: any[]): Promise<unknown>;
  // A nodes_* operation (settings.lua's Devices): null when this machine
  // isn't in the relay's account, or the relay has no tunnel.
  nodes(op: string, args: any[]): Promise<unknown>;
  // The default brain's notes, as the Worker's /api/notes and /api/goals
  // were: note_get, note_put (usage.lua's reports) and goals (the day plan's).
  notes(op: string, args: any[]): Promise<unknown>;
  // A board operation (boards.ts's, as cards/cloud.lua names them), with
  // the Worker's shapes, on a board the node keeps: see boards() below.
  boards(op: string, args: any[]): Promise<unknown>;
  // Each change to the node's boards, as BoardEvents; gives back the way to stop.
  onBoard(fn: BoardListener): () => void;
  // plan.lua's plan_* operations (plans() below).
  plans(op: string, args: any[]): Promise<unknown>;
  // Each change to a plan or the chat, as the Worker's user socket tells it.
  onDay(fn: DayListener): () => void;
  // A file on a card of a board the node keeps (media.ts), or undefined
  // when it has no such file: the Worker's, then.
  media(board: string, card: string, id: string): Promise<Response | undefined>;
  // How the bridge's sessions join this machine's hub (sessions.ts's serve).
  sessions: HubJoin;
  // Every hub of the account's, for watching its sessions (peers.ts).
  reach: Reach;
};

export type BoardListener = (key: string, event: BoardEvent) => void;
export type DayEvent = { type: "plan"; plan: Plan } | { type: "chat"; message: Message } | { type: "chat-gone"; id: string };
export type DayListener = (event: DayEvent) => void;

function kept(n: StartedNode, file: string, name: string, scope: "assistant" | "owner"): string {
  try {
    const t = readFileSync(file, "utf8").trim();
    if (n.oauth.verify(t, n.url)) return t;
  } catch {}
  const t = n.oauth.mint(name, 3650, scope);
  writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export async function startAppNode(): Promise<AppNode | undefined> {
  const store = new Keystore();
  if (!store.exists()) {
    if (signedIn()) return;
    const { account } = await localAccount();
    console.log(`node: made the account ${account} on this machine (corkboard-bridge e2ee phrase shows its recovery phrase)`);
  }
  if (store.needsPassphrase() && !process.env.CORKBOARD_E2EE_PASSPHRASE) {
    console.error("node: the account key is under a passphrase and CORKBOARD_E2EE_PASSPHRASE isn't set; memory isn't served");
    return;
  }
  const n = await startNode({ port: 0, host: "127.0.0.1", origin: undefined }).catch((e) => {
    if (e instanceof NodeRunning) return e;
    throw e;
  });
  if (n instanceof NodeRunning) return runningNode(n.pid);
  if (!n.data.brains().length) {
    await n.addBrain("pepper");
    await n.data.putBrain("pepper", { ...STARTER, created: now() });
  }
  const token = kept(n, TOKEN_FILE, "corkboard sessions", "assistant");
  kept(n, OWNER_TOKEN_FILE, "corkboard on this machine", "owner");
  // And, once the boards are the node's (the Worker answers for none of
  // them), its board tools as the session's corkboard server, over the
  // project's .mcp.json one: handoff, cards and spawns.
  const server = (tools: string) => ({ type: "http", url: `${n.url}/mcp?tools=${tools}`, headers: { Authorization: `Bearer ${token}` } });
  const hasBoards = n.replicas.objects("board").length > 0;
  writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { "corkboard-memory": server("memory"), ...(hasBoards && { corkboard: server("board") }) } }), { mode: 0o600 });
  console.log(`node on ${n.url}, account ${n.account}${n.online ? "" : " (on this machine only)"}`);
  const app: AppNode = {
    env: env(n.url),
    brains: (op, args) => brains(n, op, args),
    nodes: (op, args) => nodes(n, op, args),
    notes: (op, args) => notes(n, op, args),
    boards: (op, args) => boards(n, op, args),
    onBoard: boardEvents(n),
    plans: (op, args) => plans(n, op, args),
    onDay: dayEvents(n),
    media: async (board, card, id) => n.media.serve(board, card, id),
    sessions: joinHub(n.hub),
    reach: n.reach,
  };
  n.serveApp(
    (op, args) =>
      op.startsWith("board_") ? app.boards(op.slice("board_".length), args) : (op.startsWith("brains_") ? app.brains : op.startsWith("nodes_") ? app.nodes : op.startsWith("plan_") ? app.plans : app.notes)(op, args),
    // A day event is sent with no board: { key: null, event }.
    (fn) => {
      const boards = app.onBoard(fn);
      const day = app.onDay((event) => fn(null, event));
      return () => (boards(), day());
    },
  );
  return app;
}

const env = (url: string) => ({ CORKBOARD_MEMORY_URL: url, CORKBOARD_MEMORY_TOKEN_FILE: TOKEN_FILE, CORKBOARD_MEMORY_MCP_CONFIG: MCP_FILE });

// Another bridge's node, at the address its session-mcp.json gives (read
// each call, as it may have restarted on another port), with the owner's
// token. One that doesn't answer /app (an older bridge's) isn't used.
async function runningNode(pid: number): Promise<AppNode | undefined> {
  const where = () => {
    const url = JSON.parse(readFileSync(MCP_FILE, "utf8")).mcpServers["corkboard-memory"].url as string;
    return { url: new URL(url).origin, token: readFileSync(OWNER_TOKEN_FILE, "utf8").trim() };
  };
  const call = async (op: string, args: any[]) => {
    const { url, token } = where();
    const res = await fetch(`${url}/app`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ op, args }) });
    const json = (await res.json().catch(() => ({}))) as { value?: unknown; error?: string };
    if (!res.ok) throw new Error(json.error ?? `the node answered ${res.status}`);
    return json.value;
  };
  try {
    await call("brains_get", []);
  } catch (e) {
    console.error(`node: one is running already (pid ${pid}) and doesn't serve this bridge (${(e as Error).message}); memory isn't served here`);
    return;
  }
  const { url } = where();
  console.log(`node: using the one running already (pid ${pid}) on ${url}`);
  const listeners = new Set<BoardListener>();
  const dayListeners = new Set<DayListener>();
  const listened = () => listeners.size + dayListeners.size;
  let following = false;
  // The running node's /app/events, followed while anyone listens; when it
  // drops, each of its boards is told again whole, for what was missed.
  const follow = async () => {
    for (let retry = 1000; listened(); retry = Math.min(retry * 2, 60_000)) {
      try {
        const { url, token } = where();
        const res = await fetch(`${url}/app/events`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok || !res.body) throw new Error(`the node answered ${res.status}`);
        if (retry > 1000)
          for (const b of (await call("board_boards", [])) as { key: string }[]) {
            const event = { type: "snapshot", cards: await call("board_snapshot", [b.key]) } as BoardEvent;
            for (const fn of listeners) fn(b.key, event);
          }
        retry = 1000;
        let buf = "";
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          for (let at = buf.indexOf("\n\n"); at >= 0; at = buf.indexOf("\n\n")) {
            const msg = buf.slice(0, at);
            buf = buf.slice(at + 2);
            if (!msg.startsWith("data: ")) continue;
            const { key, event } = JSON.parse(msg.slice("data: ".length));
            if (key === null) for (const fn of dayListeners) fn(event);
            else for (const fn of listeners) fn(key, event);
          }
          if (!listened()) break;
        }
      } catch (e) {
        console.error(`node: following its boards: ${(e as Error).message}`);
      }
      await Bun.sleep(retry);
    }
    following = false;
  };
  const listen = <T>(set: Set<T>, fn: T) => {
    set.add(fn);
    if (!following) void ((following = true), follow());
    return () => void set.delete(fn);
  };
  const media = async (board: string, card: string, id: string) => {
    const { url, token } = where();
    const res = await fetch(`${url}/api/node/boards/${encodeURIComponent(board)}/cards/${encodeURIComponent(card)}/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.status === 404 ? undefined : res;
  };
  // Its hub, at /app/sessions: what it says as events while the bridge
  // follows them, and what the bridge says POSTed in order, a list at a
  // time. Joined again after a drop, for as long as the bridge runs.
  const sessions: HubJoin = (hello, connect) =>
    void (async () => {
      for (let retry = 1000; ; retry = Math.min(retry * 2, 60_000)) {
        let link: Link | undefined;
        try {
          const { url, token } = where();
          const headers = { Authorization: `Bearer ${token}` };
          const q = new URLSearchParams({ bridge: hello.id, machine: hello.machine, environment: hello.environment, ...(hello.url && { url: hello.url }) });
          const res = await fetch(`${url}/app/sessions/live?${q}`, { headers });
          if (!res.ok || !res.body) throw new Error(`the node answered ${res.status}`);
          retry = 1000;
          let queue: object[] = [];
          let sending = false;
          const flush = async () => {
            if (sending) return;
            sending = true;
            while (queue.length) {
              const batch = queue;
              queue = [];
              await fetch(`${url}/app/sessions?bridge=${encodeURIComponent(hello.id)}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(batch) }).catch(() => {});
            }
            sending = false;
          };
          link = connect((m) => void (queue.push(m), flush()));
          let buf = "";
          for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
            buf += chunk;
            for (let at = buf.indexOf("\n\n"); at >= 0; at = buf.indexOf("\n\n")) {
              const msg = buf.slice(0, at);
              buf = buf.slice(at + 2);
              if (msg.startsWith("data: ")) link.receive(JSON.parse(msg.slice("data: ".length)));
            }
          }
        } catch (e) {
          console.error(`node: this bridge's sessions: ${(e as Error).message}`);
        }
        link?.drop();
        await Bun.sleep(retry);
      }
    })();
  // Its /app/peers and /app/peer/:device/..., the body passed as it comes.
  const reach: Reach = {
    devices: async () => {
      const { url, token } = where();
      const res = await fetch(`${url}/app/peers`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`the node answered ${res.status}`);
      return (await res.json()) as { me: string; devices: string[] };
    },
    fetch: async (device, path, init = {}) => {
      const { url, token } = where();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(`${url}/app/peer/${encodeURIComponent(device)}${path}`, { ...init, headers, ...(init.body != null && { duplex: "half" }) } as RequestInit);
    },
  };
  return {
    env: env(url),
    brains: call,
    nodes: call,
    notes: call,
    boards: (op, args) => call(`board_${op}`, args),
    onBoard: (fn) => listen(listeners, fn),
    plans: call,
    onDay: (fn) => listen(dayListeners, fn),
    media,
    sessions,
    reach,
  };
}

// The account's devices as the relay knows them, this one first, and the
// leader: nodes_list, and nodes_leader with a device's id, or null.
async function nodes(n: StartedNode, op: string, args: any[]): Promise<unknown> {
  if (!n.tunnel || !n.relay) return null;
  const v = op === "nodes_leader" ? await n.relay.setLeader(args[0] ?? null) : await n.relay.nodes();
  const up = new Map(v.connected.map((c) => [c.device, c.since]));
  const known = new Map((v.known ?? []).map((k) => [k.device, k]));
  for (const d of [n.device, ...up.keys(), ...(v.leader ? [v.leader] : [])]) if (!known.has(d)) known.set(d, { device: d, name: d.slice(0, 8), seen: up.get(d) ?? 0 });
  const devices = [...known.values()]
    .map((k) => ({ ...k, me: k.device === n.device, connected: up.has(k.device), leader: k.device === v.leader }))
    .sort((a, b) => Number(b.me) - Number(a.me) || b.seen - a.seen);
  return { url: v.url, leader: v.leader, devices };
}

export async function notes(n: Pick<StartedNode, "data">, op: string, args: any[]): Promise<unknown> {
  const brain = n.data.defaultBrain();
  if (!brain) throw new Invalid("there's no default brain on this node");
  if (op === "goals") return goals(n.data.notes(brain).filter((x) => x.kind === "goal").sort((a, b) => a.id.localeCompare(b.id)));
  const id = noteId(args[0]);
  if (op === "note_get") return n.data.note(brain, id) ?? null;
  await n.data.putNote(brain, id, checkNote(args[1] ?? {}));
  return null;
}

// The brains view's operations (brains.lua), with the Worker's shapes.
async function brains(n: StartedNode, op: string, args: any[]): Promise<unknown> {
  const { data, search, episodes } = n;
  const known = (name: unknown) => {
    const b = data.brains().find((x) => x.name === name);
    if (!b) throw new Invalid(`no brain ${name}`);
    return b;
  };
  const fields = (input: Record<string, unknown> = {}) => {
    const f = Object.fromEntries(Object.entries(input).filter(([k]) => FIELDS.includes(k)));
    if (f.title !== undefined && (typeof f.title !== "string" || !f.title.trim() || f.title.length > 100)) throw new Invalid("title must be a line of at most 100 characters");
    if (typeof f.title === "string") f.title = f.title.trim();
    if (typeof f.description === "string") f.description = f.description.trim();
    return f;
  };
  const brain = (op === "brains_get" || op.startsWith("brains_hold") || op === "brains_create") ? "" : known(args[0]).name;
  switch (op) {
    case "brains_get":
      return data.brains().map((b) => {
        const last = episodes.list(b.name, 1)[0];
        return {
          ...b,
          default: !b.archived && b.name === data.defaultBrain(),
          memory: { notes: data.notes(b.name).length, entries: data.entries(b.name).length, episodes: episodes.count(b.name), lastEpisode: last?.at ?? null },
        };
      });
    case "brains_create": {
      const input = (args[0] ?? {}) as Record<string, unknown>;
      if (typeof input.name !== "string" || !NAME.test(input.name)) throw new Invalid("name must be lowercase letters, digits and -, starting with a letter, at most 32");
      const was = data.brains().find((b) => b.name === input.name);
      if (was) throw new Invalid(was.archived ? `there's an archived brain ${input.name}; restore it first` : `there's already a brain ${input.name}`);
      const f = fields(input);
      if (!f.title) throw new Invalid("a brain needs a title");
      await n.addBrain(input.name);
      return data.putBrain(input.name, { ...STARTER, description: "", abilities: [], default: false, ...f, created: now() });
    }
    case "brains_update": {
      // The form's edit, as the Worker's: stale if the brain changed since it was read.
      const b = known(brain);
      if (args[1]?.updated !== undefined && args[1].updated !== b.updated) return { stale: b, error: `${brain} changed since; here it is now` };
      return data.putBrain(brain, fields(args[1]));
    }
    case "brains_archive":
      if (brain === data.defaultBrain()) throw new Invalid("the default brain can't be archived; make another the default first");
      return data.putBrain(brain, { archived: now(), default: false });
    case "brains_restore":
      return data.putBrain(brain, { archived: null });
    case "brains_purge":
      throw new Invalid("an encrypted brain isn't purged from here yet");
    case "brains_notes":
      return data
        .notes(brain)
        .filter((x) => !BRAIN_ONLY_KINDS.includes(x.kind))
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 200)
        .map(({ body: _, ...x }) => x);
    case "brains_note": {
      const note = data.note(brain, String(args[1]));
      if (!note || BRAIN_ONLY_KINDS.includes(note.kind)) throw new Invalid(`no note ${args[1]}`);
      return note;
    }
    case "brains_days": {
      const days = new Map<string, number>();
      for (const e of data.entries(brain)) days.set(e.day, (days.get(e.day) ?? 0) + 1);
      return [...days].sort((a, b) => b[0].localeCompare(a[0])).map(([day, entries]) => ({ day, entries }));
    }
    case "brains_entries":
      return data.entries(brain, String(args[1]));
    case "brains_episodes":
      return episodes.list(brain, 50).map((e) => ({ ...e, consolidated: e.consolidated ? 1 : 0 }));
    case "brains_episode": {
      const transcript = episodes.transcript(brain, String(args[1]));
      if (transcript === undefined) throw new Invalid(`no episode ${args[1]}`);
      return { id: args[1], transcript };
    }
    case "brains_recall":
      return search.recall(brain, String(args[1] ?? ""), 15, BRAIN_ONLY_KINDS);
    case "brains_holds":
      // Holds are the fleet's, which is the Worker's.
      return signedIn() ? undefined : { holds: [], waiting: [] };
    default:
      if (signedIn()) return undefined;
      throw new Invalid("holds are the fleet's, which needs signing in");
  }
}

// Boards ---------------------------------------------------------------------------

// A board as the Worker's GET /api/boards lists it: Open project's (picker.lua).
function listed(data: Data, key: string) {
  const s = data.board(key);
  return {
    key,
    name: typeof s.name === "string" ? s.name : key,
    root: typeof s.root === "string" ? s.root : null,
    commit: typeof s.commit === "string" ? s.commit : null,
    remotes: Array.isArray(s.remotes) ? s.remotes : [],
    environments: Object.keys(s.roots ?? {}).sort(),
  };
}

// Where a project's clone is, as boards.ts finds it: its root on the
// environment it's on, its first commit, its remotes.
type Place = { root: string | null; environment: string | null; commit?: string; remotes?: string[] };

// The board's settings for a place (the Worker's PUT /api/boards/:key):
// its root is the last one opened, and each environment's is kept.
async function place(n: Pick<StartedNode, "data">, key: string, name: string | undefined, p: Place) {
  const had = n.data.board(key);
  const set: Record<string, unknown> = {};
  if (name || had.name === undefined) set.name = name || key;
  if (p.root) set.root = p.root;
  if (p.commit) set.commit = p.commit;
  if (p.remotes?.length) set.remotes = p.remotes;
  if (p.environment && p.root) set.roots = { ...(had.roots ?? {}), [p.environment]: p.root };
  await n.data.putBoard(key, set);
}

// cards/cloud.lua's operations on a board the node keeps (boards.ts decides
// which those are), with the Worker's shapes. resolve answers from the
// node's boards alone, null for none; subscribe and make take the place
// boards.ts found for the clone, and make (subscribe's, or make's own)
// keeps a board the node didn't have. update doesn't conflict: fields
// merge, so a card's version is only for cloud.lua's copy to order by.
// touch keeps a working card's claim (leases.ts); token is a card grant
// (oauth.ts) for agents.lua's agent, at this node's /mcp, and revoke ends it.
// delete lets go of the card's files too.
export async function boards(n: Pick<StartedNode, "data" | "replicas" | "addBoard" | "oauth" | "url" | "media">, op: string, args: any[]): Promise<unknown> {
  const { data } = n;
  const has = (key: string) => n.replicas.get("board", key) !== undefined;
  if (op === "boards") return data.boards().map((b) => listed(data, b.key)).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  if (op === "resolve") {
    const [pathKey, commit] = args;
    const found = data.boards().filter((b) => data.board(b.key).commit === commit).map((b) => b.key);
    return found.includes(pathKey) ? pathKey : (found[0] ?? null);
  }
  const [key] = args;
  if (typeof key !== "string" || !key) throw new Invalid("no board key");
  if (op === "subscribe" || op === "make") {
    const [, name, p, make] = args as [string, string, Place, boolean?];
    if (!has(key)) {
      if (op === "subscribe" && !make) return null;
      await n.addBoard(key);
    }
    await place(n, key, op === "make" || make ? name : undefined, p ?? { root: null, environment: null });
    return op === "make" ? listed(data, key) : data.cards(key);
  }
  // Its settings, each environment's root among them (server.ts's /open).
  if (op === "board") return has(key) ? data.board(key) : null;
  if (!has(key)) throw new Invalid(`no board ${key} on this node`);
  const strip = ({ log: _, ...c }: FullCard): Card => c;
  switch (op) {
    case "snapshot":
      return data.cards(key);
    case "create":
      return data.createCard(key, args[1] ?? {});
    case "update":
      return { card: strip(await data.updateCard(key, String(args[1]), args[3] ?? {})) };
    case "log":
      return data.appendLog(key, String(args[1]), String(args[2]), String(args[3] ?? ""));
    case "archive":
      return strip(await data.archive(key, String(args[1]), true));
    case "delete":
      await data.deleteCard(key, String(args[1]));
      await n.media.forget(key, String(args[1]));
      return null;
    case "touch":
      return touch(data, key, String(args[1]).toUpperCase(), String(args[2]));
    case "token": {
      const [, card, agent] = args;
      if (typeof agent !== "string" || !agent.trim()) throw new Invalid("agent must be the agent's name");
      const id = data.card(key, String(card).toUpperCase()).id;
      return { ...n.oauth.mintBound({ scope: "card", board: key, card: id, agent: agent.trim() }), url: `${n.url}/mcp` };
    }
    case "revoke":
      n.oauth.revokeToken(String(args[1]));
      return null;
    default:
      throw new Invalid(`no board operation ${op}`);
  }
}

// The node's boards' changes, as the Worker's board socket tells them
// (lib/model/cards.ts's BoardEvent): a card changed, a log entry added, a
// card off the board, and the whole board when one comes back (with its
// log) or another device's entry lands before ours. Each board as last
// told, kept while anyone listens.
export function boardEvents(n: Pick<StartedNode, "data" | "replicas">): (fn: BoardListener) => () => void {
  const listeners = new Set<BoardListener>();
  type Told = Map<string, { card: string; log: string[] }>;
  const told = new Map<string, Told>();
  const now = (key: string): Told => new Map(n.data.cards(key).map(({ log, ...c }) => [c.id, { card: JSON.stringify(c), log: log.map((e) => JSON.stringify(e)) }]));
  const tell = (key: string, event: BoardEvent) => {
    for (const fn of listeners) fn(key, event);
  };
  n.replicas.onChange((o) => {
    if (o.kind !== "board" || !listeners.size) return;
    const was: Told = told.get(o.name) ?? new Map();
    const is = now(o.name);
    told.set(o.name, is);
    const events: BoardEvent[] = [];
    for (const id of was.keys()) if (!is.has(id)) events.push({ type: "removed", id });
    for (const [id, c] of is) {
      const had = was.get(id);
      if (!had && c.log.length) return tell(o.name, { type: "snapshot", cards: n.data.cards(o.name) });
      if (had && had.log.some((e, i) => c.log[i] !== e)) return tell(o.name, { type: "snapshot", cards: n.data.cards(o.name) });
      if (had?.card !== c.card) events.push({ type: "card", card: JSON.parse(c.card) });
      for (const e of c.log.slice(had?.log.length ?? 0)) events.push({ type: "log", id, entry: JSON.parse(e) });
    }
    for (const e of events) tell(o.name, e);
  });
  return (fn) => {
    if (!listeners.size) for (const o of n.replicas.objects("board")) told.set(o.name, now(o.name));
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
}

// Day plans --------------------------------------------------------------------------

// plan.lua's operations, with cloud-session.ts's shapes: plan_get the plan;
// the rest { plan }, or { conflict } with the plan as it is when the version
// given is gone by. plan_subscribe and plan_boards are boards.ts's.
export async function plans(n: Pick<StartedNode, "data">, op: string, args: any[]): Promise<unknown> {
  const [date, ...rest] = args;
  const d = checkDate(date);
  const version = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);
  const settle = async (p: Promise<Plan>) => {
    try {
      return { plan: await p };
    } catch (e) {
      if (e instanceof Conflict && e.plan) return { conflict: e.plan };
      throw e;
    }
  };
  switch (op) {
    case "plan_get":
      return n.data.plan(d);
    case "plan_say":
      return settle(n.data.say(d, "me", chatText(rest[0])));
    case "plan_accept":
      return settle(n.data.accept(d, version(rest[0]), checkBlocks(rest[1]), typeof rest[2] === "string" ? rest[2] : undefined));
    case "plan_discard":
      return settle(n.data.discard(d, version(rest[0]), typeof rest[1] === "string" ? rest[1] : undefined));
    case "plan_day":
      return settle(n.data.setDay(d, version(rest[0]), checkBlocks(rest[1])));
    default:
      throw new Invalid(`no plan operation ${op}`);
  }
}

// The day object's changes as the Worker's user socket tells them: a plan
// that changed, whole; a message new or changed; one taken back. Each as
// last told, kept while anyone listens.
export function dayEvents(n: Pick<StartedNode, "data" | "replicas">): (fn: DayListener) => () => void {
  const listeners = new Set<DayListener>();
  const plans = new Map<string, string>();
  const messages = new Map<string, string>();
  const look = (tell: (e: DayEvent) => void) => {
    for (const date of n.data.planDates()) {
      const plan = n.data.plan(date);
      const s = JSON.stringify(plan);
      if (plans.get(date) === s) continue;
      plans.set(date, s);
      tell({ type: "plan", plan });
    }
    const now = new Map(n.data.chat(undefined, Number.MAX_SAFE_INTEGER).map((m) => [m.id, m] as const));
    for (const id of [...messages.keys()].filter((id) => !now.has(id))) {
      messages.delete(id);
      tell({ type: "chat-gone", id });
    }
    for (const [id, message] of now) {
      const s = JSON.stringify(message);
      if (messages.get(id) === s) continue;
      messages.set(id, s);
      tell({ type: "chat", message });
    }
  };
  n.replicas.onChange((o) => {
    if (o.kind !== "day" || !listeners.size) return;
    look((e) => {
      for (const fn of listeners) fn(e);
    });
  });
  return (fn) => {
    if (!listeners.size && n.replicas.get("day", DAY)) look(() => {});
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
}
