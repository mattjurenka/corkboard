// A resident that is an assistant (the manifest's `assistant`, as Pepper's
// VM on the droplet, fleet/pepper): one Claude Code session in tmux, always
// running, reached over ssh. fleetd gives it what it can't get itself, being
// signed in to the Worker as it is:
//
// - Its token: its brain's token (Pepper's is the one grant that sees the
//   goals), minted here and written to `tokenFile` in the guest, which the
//   session's corkboard MCP server and memory hooks read. Replaced each day,
//   the old one revoked. The machine token that mints it never goes in the VM.
//
// - With `chat`, the phone's chat (the hosted Worker's user.ts): each new
//   message of the user's is pasted into the session as a line starting
//   "[phone]", and the assistant answers it with chat_send. One session,
//   whichever side is talking. The user has one chat, so one resident has it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";
import type { Assistant } from "./fleet";

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? "/var/lib/corkboard/state", "corkboard");
const DAY = 24 * 3600_000;

// The newest message passed on, and the token it has and when it was made.
type State = { last: number; token?: string; minted?: number };
// by_user: the user's own, from the phone; a Worker from before it says "matt".
type Message = { id: number; at: string; who: string; text: string; by_user?: boolean };
const byUser = (m: Message) => m.by_user ?? m.who === "matt";

// A slash command from the phone runs as one, and the assistant says how it
// went in the chat. Bare /mcp is a menu the phone can't work, so it
// reconnects them all.
export function command(text: string): string | undefined {
  const t = text.trim();
  if (!/^\/[a-z][\w:-]*(\s|$)/i.test(t)) return;
  return t === "/mcp" ? "/mcp reconnect all" : t;
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
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

async function spawn(cmd: string[], stdin?: string) {
  const proc = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.at(-1)}: ${err.trim() || `exit ${code}`}`);
}

export function assist(name: string, brain: string, a: Assistant) {
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

  // One prompt into the session, pasted (bracketed, so its newlines don't send
  // it early) and sent.
  async function prompt(text: string) {
    await tmux(["load-buffer", "-b", "phone", "-"], text);
    await tmux(["paste-buffer", "-p", "-d", "-b", "phone", "-t", session]);
    await tmux(["send-keys", "-t", session, "Enter"]);
  }

  // Each message the user sent since the last one passed on, as a line
  // starting "[phone]", or a command. Claude Code queues what arrives while
  // it's busy. Without a session (between days, or restarting) they wait for
  // the next try.
  async function pass(s: State) {
    const said = ((await api("GET", `/api/chat?after=${s.last}`)) as Message[]).filter(byUser);
    for (const m of said) {
      // Marked passed on first, so it can't change after; its text as it is now. Taken back: skipped.
      const now = await api("POST", `/api/chat/${m.id}/delivered`, {}).catch((e: Error) => (e.message.includes("no message") ? null : Promise.reject(e)));
      if (now) {
        const run = command(now.text);
        if (run) {
          await prompt(run);
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
    const recent = a.chat ? ((await api("GET", "/api/chat")) as Message[]) : [];
    state = { last: recent.at(-1)?.id ?? 0 };
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

  tick();
  if (a.chat) follow();
  // What the socket missed, and the token's day.
  setInterval(tick, 30_000);
}
