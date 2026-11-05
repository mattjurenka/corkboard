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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedIn } from "../cloud";
import { localAccount } from "../e2ee";
import { Keystore } from "../keystore";
import { goals } from "../../lib/model/goals";
import { BRAIN_ONLY_KINDS, note as checkNote, noteId } from "../../lib/model/plans";
import { Invalid, now } from "./data";
import { NODE_DIR, type StartedNode, startNode } from "./serve";

const TOKEN_FILE = join(NODE_DIR, "session-token");
const MCP_FILE = join(NODE_DIR, "session-mcp.json");
export const OWNER_TOKEN_FILE = join(NODE_DIR, "owner-token");

// The Worker's STARTER (corkboard-cloud's brains.ts).
const STARTER = { title: "Assistant", description: "Your assistant.", account: null, credentials: [], abilities: ["chat"], persona: null, skin: null, default: true };
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FIELDS = ["title", "description", "account", "credentials", "abilities", "persona", "skin", "default"];

export type AppNode = StartedNode & {
  env: Record<string, string>;
  // A brains_* operation answered here, or undefined for the Worker's.
  brains(op: string, args: any[]): Promise<unknown>;
  // A nodes_* operation (settings.lua's Devices): null when this machine
  // isn't in the relay's account, or the relay has no tunnel.
  nodes(op: string, args: any[]): Promise<unknown>;
  // The default brain's notes, as the Worker's /api/notes and /api/goals
  // were: note_get, note_put (usage.lua's reports) and goals (the day plan's).
  notes(op: string, args: any[]): Promise<unknown>;
};

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
  const n = await startNode({ port: 0, host: "127.0.0.1", origin: undefined });
  if (!n.data.brains().length) {
    await n.addBrain("assistant");
    await n.data.putBrain("assistant", { ...STARTER, created: now() });
  }
  const token = kept(n, TOKEN_FILE, "corkboard sessions", "assistant");
  kept(n, OWNER_TOKEN_FILE, "corkboard on this machine", "owner");
  writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { "corkboard-memory": { type: "http", url: `${n.url}/mcp?tools=memory`, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
  console.log(`node on ${n.url}, account ${n.account}${n.online ? "" : " (on this machine only)"}`);
  return { ...n, env: { CORKBOARD_MEMORY_URL: n.url, CORKBOARD_MEMORY_TOKEN_FILE: TOKEN_FILE, CORKBOARD_MEMORY_MCP_CONFIG: MCP_FILE }, brains: (op, args) => brains(n, op, args), nodes: (op, args) => nodes(n, op, args), notes: (op, args) => notes(n, op, args) };
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
