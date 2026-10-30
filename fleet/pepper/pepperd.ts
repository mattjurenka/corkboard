// Pepper's other half on the droplet (fleet/pepper/pepper.nix): Pepper is
// one Claude Code session, in tmux as the `pepper` user, which the day plan's
// window attaches to over ssh (nvim/lua/corkboard/plan/claude.lua). This
// runs beside it as the user signed in to the Worker (`corkboard`, as fleetd)
// and gives it what it can't get itself:
//
// - Its token: a Pepper token (the one grant that sees the goals), minted
//   here and written to PEPPER_TOKEN_FILE, which the session's corkboard MCP
//   server and memory hooks read. Replaced each day, the old one revoked.
//
// - The phone's chat (cloud/src/user.ts): each new message of the user's is
//   pasted into the session as a line starting "[phone]", and Pepper answers
//   it with chat_send. One session, whichever side is talking.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";

const TOKEN_FILE = process.env.PEPPER_TOKEN_FILE ?? "/var/lib/pepper/corkboard-token";
const TMUX = (process.env.PEPPER_TMUX ?? "tmux -S /run/pepper/tmux.sock").split(" ");
// The ssh into Pepper's VM (fleet/pepper/guest.nix), when the session is
// there: the token file is the guest's.
const SSH = process.env.PEPPER_SSH?.split(" ");
const SESSION = "pepper";
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? "/var/lib/corkboard/state", "corkboard");
const STATE = join(STATE_DIR, "pepper.json");
const DAY = 24 * 3600_000;

// The newest message passed on, and the token Pepper has and when it was made.
type State = { last: number; token?: string; minted?: number };
type Message = { id: number; at: string; who: string; text: string };

function load(): State | undefined {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return undefined;
  }
}

function save(state: State) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, JSON.stringify(state) + "\n", { mode: 0o600 });
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CLOUD}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`pepperd: ${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

async function spawn(cmd: string[], stdin?: string) {
  const proc = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pepperd: ${cmd.at(-1)}: ${err.trim() || `exit ${code}`}`);
}

const tmux = (args: string[], stdin?: string) => spawn([...TMUX, ...args], stdin);

// Its token ---------------------------------------------------------------------------

// Tokens last 7 days (cloud/src/api.ts); a new one each day leaves room for
// days this isn't running. The file is written in place: it's the session's
// to read, not to replace.
async function renew(state: State) {
  if (state.token && state.minted && Date.now() - state.minted < DAY) return;
  const { token: pepper } = await api("POST", "/api/tokens/pepper", {});
  if (SSH) await spawn([...SSH, `cat > ${TOKEN_FILE}`], pepper);
  else writeFileSync(TOKEN_FILE, pepper);
  const old = state.token;
  Object.assign(state, { token: pepper, minted: Date.now() });
  save(state);
  if (old) await api("POST", "/api/tokens/revoke", { token: old }).catch(() => {});
  console.log("pepperd: Pepper has a new token");
}

// The phone's chat ----------------------------------------------------------------------

// Each message the user sent since the last one passed on, pasted as one
// prompt (bracketed, so its newlines don't send it early) and sent. Claude
// Code queues what arrives while it's busy. Without a session (between days,
// or restarting) they wait for the next try.
async function pass(state: State) {
  const said = ((await api("GET", `/api/chat?after=${state.last}`)) as Message[]).filter((m) => m.who === "matt");
  for (const m of said) {
    await tmux(["load-buffer", "-b", "phone", "-"], `[phone] ${m.text}`);
    await tmux(["paste-buffer", "-p", "-d", "-b", "phone", "-t", SESSION]);
    await tmux(["send-keys", "-t", SESSION, "Enter"]);
    state.last = m.id;
    save(state);
  }
}

// Following -----------------------------------------------------------------------------

let state = load();
let busy = false;
let again = false;

// A first run passes on nothing already in the chat.
async function ready(): Promise<State> {
  if (state) return state;
  const recent = (await api("GET", "/api/chat")) as Message[];
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
      await renew(s);
      await pass(s);
    } while (again);
  } catch (e) {
    console.error((e as Error).message);
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
        if (event.type === "chat" && event.message?.who === "matt") tick();
      } catch {}
    };
    ws.onclose = () => {
      clearInterval(ping);
      setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
    };
  } catch (e) {
    console.error((e as Error).message);
    setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
  }
}

tick();
follow();
// What the socket missed, and the token's day.
setInterval(tick, 30_000);
