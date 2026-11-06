// A resident that is an assistant (the manifest's `assistant`, as Pepper's
// VM on the droplet, fleet/pepper): one Claude Code session in tmux, always
// running, reached over ssh. fleetd gives it what it can't get itself, being
// signed in to the Worker as it is:
//
// - Its token: its brain's token (Pepper's is the one grant that sees the
//   goals), minted here and written to `tokenFile` in the guest, which the
//   session's corkboard MCP server and memory hooks read. Replaced each day,
//   the old one revoked. The machine token that mints it never goes in the VM.
//   With the manifest's node and `memoryTokenFile`, a second: the brain's on
//   the node, for the memory hooks and corkboard-memory, minted there
//   (its POST /api/node/grants) and replaced each day the same way.
//
// - With `chat`, the phone's chat (the hosted Worker's user.ts): each new
//   message of the user's is pasted into the session as a line starting
//   "[phone]", and the assistant answers it with chat_send. One session,
//   whichever side is talking. The user has one chat, so one resident has it.
//   Once the chat has moved to the user's node (the Worker answers 410:
//   .agent/plans/local-plans.md, step 5), it's the node's, at the manifest's
//   node, read after each change to the node's day object (its
//   /api/node/day/events), or every ten seconds while that's down.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";
import type { Assistant } from "./fleet";

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? "/var/lib/corkboard/state", "corkboard");
const DAY = 24 * 3600_000;

// The newest message passed on (the node's ids are strings, from: "node"),
// and the tokens it has and when they were made: the Worker's, and the node's.
type State = { last: number | string; from?: "node"; token?: string; minted?: number; nodeToken?: string; nodeMinted?: number };
// by_user: the user's own, from the phone; a Worker from before it says "matt".
type Message = { id: number | string; at: string; who: string; text: string; by_user?: boolean; delivered?: string | null };
type Node = { url: string; tokenFile: string };
const byUser = (m: Message) => m.by_user ?? m.who === "matt";

// A slash command from the phone runs as one, and the assistant says how it
// went in the chat. Bare /mcp is a menu the phone can't work, so it
// reconnects them all.
export function command(text: string): string | undefined {
  const t = text.trim();
  if (!/^\/[a-z][\w:-]*(\s|$)/i.test(t)) return;
  return t === "/mcp" ? "/mcp reconnect all" : t;
}

// Whether a command's result is on the screen: a "⎿" line under its last
// "❯ <command>".
export function ran(screen: string[], run: string): boolean {
  const at = screen.findLastIndex((l) => l.trimEnd() === `❯ ${run}`);
  return at >= 0 && screen.slice(at + 1).some((l) => l.trimStart().startsWith("⎿"));
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CLOUD}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    // One that never answers would hold up every tick after it.
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (res.status === 410) throw new Gone(`${method} ${path}: moved`);
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

class Gone extends Error {}

// The chat: the Worker's, or the node's once the Worker's answers 410;
// node says which answered.
async function chatApi(node: Node | undefined, method: string, path: string, body?: unknown): Promise<{ node: boolean; json: any }> {
  try {
    return { node: false, json: await api(method, `/api${path}`, body) };
  } catch (e) {
    if (!(e instanceof Gone) || !node) throw e;
  }
  return { node: true, json: await nodeApi(node, method, path, body) };
}

// The node's API, through its tunnel, with fleetd's owner token for it.
async function nodeApi(node: Node, method: string, path: string, body?: unknown) {
  const res = await fetch(`${node.url}/api/node${path}`, {
    method,
    headers: { Authorization: `Bearer ${readFileSync(node.tokenFile, "utf8").trim()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`the node: ${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

async function spawn(cmd: string[], stdin?: string) {
  const proc = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.at(-1)}: ${err.trim() || `exit ${code}`}`);
}

export function assist(name: string, brain: string, a: Assistant, node?: Node) {
  const ssh = a.ssh.split(" ");
  const tmux = (args: string[], stdin?: string) => spawn([...ssh, "tmux", "-S", a.tmuxSocket, ...args], stdin);
  const session = a.session ?? brain;
  // The brain's name, so Pepper's is pepperd's pepper.json from before.
  const file = join(STATE_DIR, `${brain}.json`);
  const log = (s: string) => console.log(`${name}: ${s}`);
  const fail = (e: unknown) => console.error(`${name}: ${(e as Error).message}`);

  const load = (): State | undefined => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  const save = (s: State) => {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(s) + "\n", { mode: 0o600 });
  };

  // Tokens last 7 days (the hosted Worker's api.ts); a new one each day leaves room for
  // days fleetd isn't running. The file is written in place: it's the session's
  // to read, not to replace.
  async function renew(s: State) {
    if (s.token && s.minted && Date.now() - s.minted < DAY) return;
    const { token: fresh } = await api("POST", `/api/brains/${brain}/tokens`, {});
    await spawn([...ssh, `cat > ${a.tokenFile}`], fresh);
    const old = s.token;
    Object.assign(s, { token: fresh, minted: Date.now() });
    save(s);
    if (old) await api("POST", "/api/tokens/revoke", { token: old }).catch(() => {});
    log("a new token");
  }

  // The node's grants last a week too (server.ts's grants).
  async function renewNode(s: State) {
    if (!node || !a.memoryTokenFile || (s.nodeToken && s.nodeMinted && Date.now() - s.nodeMinted < DAY)) return;
    const { token: fresh } = await nodeApi(node, "POST", "/grants", { scope: "brain", brain, agent: name });
    await spawn([...ssh, `cat > ${a.memoryTokenFile}`], fresh);
    const old = s.nodeToken;
    Object.assign(s, { nodeToken: fresh, nodeMinted: Date.now() });
    save(s);
    if (old) await nodeApi(node, "DELETE", "/grants", { token: old }).catch(() => {});
    log("a new token on the node");
  }

  // One prompt into the session, pasted (bracketed, so its newlines don't send
  // it early) and sent.
  async function prompt(text: string) {
    await tmux(["load-buffer", "-b", "phone", "-"], text);
    await tmux(["paste-buffer", "-p", "-d", "-b", "phone", "-t", session]);
    await tmux(["send-keys", "-t", session, "Enter"]);
  }

  // A command runs at once, not queued, and what's pasted while it runs is
  // lost: so the next prompt waits for its result (a "⎿" line under it on
  // the screen), or a minute and a half.
  async function done(run: string) {
    for (let i = 0; i < 90; i++) {
      await Bun.sleep(1000);
      const proc = Bun.spawn([...ssh, "tmux", "-S", a.tmuxSocket, "capture-pane", "-p", "-t", session, "-S", "-40"], { stdout: "pipe", stderr: "ignore" });
      const screen = (await new Response(proc.stdout).text()).split("\n");
      if (ran(screen, run)) return;
    }
  }

  // Each message the user sent since the last one passed on, as a line
  // starting "[phone]", or a command. Claude Code queues what arrives while
  // it's busy. Without a session (between days, or restarting) they wait for
  // the next try.
  const chat = (method: string, path: string, body?: unknown) => chatApi(node, method, path, body);

  async function pass(s: State) {
    let got = await chat("GET", `/chat?after=${s.last}`);
    // Moved since the last: from the newest the move says was passed on.
    if (got.node && s.from !== "node") {
      const all = (await chat("GET", "/chat?limit=500")).json as Message[];
      Object.assign(s, { from: "node", last: all.filter((m) => m.delivered).at(-1)?.id ?? "" });
      save(s);
      got = await chat("GET", `/chat?after=${s.last}`);
    }
    const said = (got.json as Message[]).filter(byUser);
    for (const m of said) {
      // Marked passed on first, so it can't change after; its text as it is now. Taken back: skipped.
      const now = (await chat("POST", `/chat/${m.id}/delivered`, {}).catch((e: Error) => (/no message/.test(e.message) ? null : Promise.reject(e))))?.json;
      if (now) {
        const run = command(now.text);
        if (run) {
          await prompt(run);
          await done(run);
          await prompt(`[phone] I ran ${run} from my phone. Tell me in the chat what it showed.`);
        } else await prompt(`[phone] ${now.text}`);
      }
      s.last = m.id;
      save(s);
    }
  }

  let state = load();
  let busy = false;
  let again = false;

  // A first run passes on nothing already in the chat.
  async function ready(): Promise<State> {
    if (state) return state;
    const got = a.chat ? await chat("GET", "/chat") : { node: false, json: [] };
    const recent = got.json as Message[];
    state = { last: recent.at(-1)?.id ?? (got.node ? "" : 0), ...(got.node ? { from: "node" as const } : {}) };
    save(state);
    return state;
  }

  async function tick() {
    if (busy) return void (again = true);
    busy = true;
    try {
      const s = await ready();
      do {
        again = false;
        // The token it has lasts days: a failed renewal mustn't hold up the chat.
        await renew(s).catch(fail);
        await renewNode(s).catch(fail);
        if (a.chat) await pass(s);
      } while (again);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  let retry = 1000;
  async function follow() {
    try {
      const ws = new WebSocket(`${CLOUD.replace(/^http/, "ws")}/api/live`, { headers: { Authorization: `Bearer ${await token()}` } } as any);
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      ws.onopen = () => {
        retry = 1000;
        tick();
      };
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(String(e.data));
          if (event.type === "chat" && event.message && byUser(event.message)) tick();
        } catch {}
      };
      ws.onclose = () => {
        clearInterval(ping);
        setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
      };
    } catch (e) {
      fail(e);
      setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
    }
  }

  // The node's day events, once the chat is the node's: any is a reason to read it.
  let following = false;
  let nodeRetry = 1000;
  async function followNode() {
    if (!node || state?.from !== "node") return void setTimeout(followNode, 10_000);
    try {
      const res = await fetch(`${node.url}/api/node/day/events`, { headers: { Authorization: `Bearer ${readFileSync(node.tokenFile, "utf8").trim()}` } });
      if (!res.ok || !res.body) throw new Error(`the node's day events: HTTP ${res.status}`);
      following = true;
      nodeRetry = 1000;
      tick();
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop()!;
        if (events.some((e) => e.startsWith("data:"))) tick();
      }
    } catch (e) {
      fail(e);
    }
    following = false;
    setTimeout(followNode, (nodeRetry = Math.min(nodeRetry * 2, 60_000)));
  }

  tick();
  if (a.chat) follow();
  if (a.chat && node) followNode();
  // What the sockets missed, and the token's day; the node's chat while its events are down.
  let beats = 0;
  setInterval(() => ((state?.from === "node" && !following) || ++beats % 3 === 0) && tick(), 10_000);
}
