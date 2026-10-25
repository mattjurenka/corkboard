// What corkboard's phone app (android/) needs from this machine, done by
// one bridge on it (a lock file) while it follows the user's live socket:
//
// - Pepper's answers to the phone's chat (cloud/src/user.ts). For each new
//   message of the user's, a turn of Pepper's Claude Code in pepper-vm
//   (`pepper-vm-ssh claude -p`, resuming the day's session), whose answer
//   goes to the chat as Pepper. Pepper reaches corkboard with a Pepper token,
//   as in the day plan's window (nvim/lua/corkboard/plan/claude.lua): minted
//   for the turn, written into the guest unless that window's session already
//   put one there, and taken out and revoked after. The answer goes back over
//   MCP with the same token (chat_send), since only Pepper's speaks as Pepper.
//   Needs pepper-vm-ssh on the PATH.
//
// - The calendar, for a plan accepted on the phone. Accepting in the day
//   plan's window writes the Claude calendar with `dayplan apply` first,
//   which is what opens the dayplan gate (plan.lua's accept); the phone
//   can't, so a plan accepted anywhere but here is written now, the same
//   way. Accepts made through this machine's bridges are marked
//   (acceptedHere) so they aren't written twice. Needs dayplan.
//
// CORKBOARD_PHONE=0 turns it off.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLOUD, token } from "./cloud";

const VIA = ["pepper-vm-ssh"];
const GUEST_TOKEN = "/var/lib/pepper/corkboard-token";
const DAYPLAN = process.env.CORKBOARD_DAYPLAN ?? "dayplan";
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard");
const STATE = join(STATE_DIR, "phone.json");
const LOCK = join(STATE_DIR, "phone.lock");
const HERE = join(STATE_DIR, "accepted-here");

// The newest message answered, the day's Pepper session to resume, and the
// accept whose calendar is written.
type State = { last: number; date?: string; session?: string; written?: string };
type Message = { id: number; at: string; who: string; text: string };
type Block = { id: string; start: number; stop: number; title: string; kind: string; desc?: string };
type Plan = { date: string; accepted: string | null; day: { blocks: Block[] } };

const PROMPT = `You are Pepper, Matt's personal assistant. Matt is talking to you from corkboard's phone app; this is a chat,
and your final answer each turn is sent to his phone as your reply, as plain text (no markdown, short paragraphs).
Don't also send it with chat_send; use chat_send only for a quick word before a long piece of work ("On it").
You run in a VM of your own: none of Matt's files are here, and you reach only Anthropic, corkboard and Google.
In the morning his phone keeps his distracting apps locked until today's plan is accepted and he has meditated for 30
minutes. When he asks you to plan or re-plan the day, read today's plan with plan_read (keep the ids of blocks you don't
change; minutes since midnight), plan it as the plan-my-day skill would, and call plan_propose. He reviews and accepts it
on his phone. You can't accept it for him, and he can't skip planning by asking you to.
Use corkboard's notes for what happened on earlier days and for his goals (kind goal; only you see them).
You don't do coding or project work yourself: for that, make a card on the project's board with create_card (status
ready, a description a fresh session can act on, attention set to one line), and tell him its id.`;

const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());

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

// A plan accepted through a bridge on this machine, so its calendar was
// written here (boards.ts's plan_accept, after plan.lua's dayplan apply).
export function acceptedHere(stamp: string) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HERE, stamp, { mode: 0o600 });
}

const readHere = () => {
  try {
    return readFileSync(HERE, "utf8");
  } catch {
    return "";
  }
};

// The lock: a file holding the pid of the bridge that does this. A stale
// one, whose process is gone, is taken over.
function lock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
        } catch {}
      };
      process.on("exit", release);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (release(), process.exit(0)));
      return true;
    } catch {
      const pid = Number(readFileSync(LOCK, "utf8"));
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        unlinkSync(LOCK);
      }
    }
  }
  return false;
}

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(`${CLOUD}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer ?? (await token())}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`corkboard phone: ${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

// Run a command with stdin; its stdout, or an error.
async function run(args: string[], stdin: string): Promise<string> {
  const proc = Bun.spawn(args, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.replace(/Pseudo-terminal will not be allocated.*\n/, "").trim() || `exit ${code}`);
  return out;
}

const guest = (args: string[], stdin: string) => run([...VIA, ...args], stdin);

// Pepper's chat ---------------------------------------------------------------------

// Say something in the chat as Pepper.
const send = (pepper: string, text: string) =>
  api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_send", arguments: { text: text.slice(0, 4000) } } }, pepper);

// One turn: everything the user said since the last answer, answered once.
async function turn(state: State) {
  const said = ((await api("GET", `/api/chat?after=${state.last}`)) as Message[]).filter((m) => m.who === "matt");
  if (!said.length) return;
  const newest = said.at(-1)!.id;
  const { token: pepper } = await api("POST", "/api/tokens/pepper", {});
  let wrote = false;
  try {
    wrote = (await guest(["sh", "-c", `umask 077; if [ -s ${GUEST_TOKEN} ]; then echo kept; else cat > ${GUEST_TOKEN}; echo wrote; fi`], pepper)).trim() === "wrote";
    const resume = state.date === today() && state.session ? ["--resume", state.session] : [];
    const text = said.map((m) => m.text).join("\n\n");
    const prompt = resume.length ? text : `${PROMPT}\n\nMatt says:\n${text}`;
    const out = await guest(["claude", "-p", "--output-format", "json", "--allowedTools", "mcp__corkboard", ...resume], prompt);
    const result = JSON.parse(out) as { result?: string; session_id?: string; is_error?: boolean };
    if (result.session_id) Object.assign(state, { date: today(), session: result.session_id });
    await send(pepper, result.is_error || !result.result?.trim() ? `(I couldn't answer that: ${result.result ?? "no reply"})` : result.result.trim());
  } catch (e) {
    await send(pepper, `(I couldn't answer that: ${(e as Error).message.slice(0, 300)})`).catch(() => {});
    // Start the day's session over next time, in case it's the one at fault.
    delete state.session;
  } finally {
    state.last = newest;
    save(state);
    if (wrote) {
      // Only ours: the day plan's window may have put its own there since.
      await guest(["sh", "-c", `read t; [ "$(cat ${GUEST_TOKEN})" = "$t" ] && rm -f ${GUEST_TOKEN}; true`], pepper + "\n").catch(() => {});
    }
    await api("POST", "/api/tokens/revoke", { token: pepper }).catch(() => {});
  }
}

// The calendar ----------------------------------------------------------------------

const clock = (m: number) => (m >= 24 * 60 ? "23:59" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

// dayplan apply's blocks, as plan.lua's calendar_blocks: what's still ahead
// and isn't already a calendar event.
function calendarBlocks(plan: Plan) {
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  return plan.day.blocks
    .filter((b) => b.kind !== "fixed" && b.stop > now)
    .map((b) => ({ title: b.title, desc: b.desc ?? "", start: `${plan.date}T${clock(Math.max(b.start, now))}`, end: `${plan.date}T${clock(b.stop)}` }));
}

async function calendar(state: State, plan: Plan) {
  if (!plan.accepted || plan.date !== today() || plan.accepted === state.written) return;
  // An accept made here marks itself once the Worker answers it, which can
  // be a moment after the socket tells of it.
  await new Promise((r) => setTimeout(r, 3000));
  if (plan.accepted === state.written) return;
  state.written = plan.accepted;
  save(state);
  if (readHere() === plan.accepted) return;
  const blocks = calendarBlocks(plan);
  if (!blocks.length) return;
  try {
    console.log(`corkboard phone: a plan accepted elsewhere: ${(await run([DAYPLAN, "apply"], JSON.stringify({ blocks, approve: true }))).trim()}`);
  } catch (e) {
    console.error(`corkboard phone: dayplan apply failed for the plan accepted elsewhere: ${(e as Error).message}`);
  }
}

// Following -------------------------------------------------------------------------

export function start() {
  if (process.env.CORKBOARD_PHONE === "0") return;
  const chat = !!Bun.which(VIA[0]);
  const cal = !!Bun.which(DAYPLAN);
  if ((!chat && !cal) || !lock()) return;
  let state: State | undefined = load();
  let busy = false;
  let again = false;

  // A first run answers nothing already in the chat, and writes no plan
  // already accepted.
  const ready = async (): Promise<State> => {
    if (state) return state;
    const recent = (await api("GET", "/api/chat").catch(() => [])) as Message[];
    const plan = (await api("GET", `/api/plans/${today()}`)) as Plan;
    state = { last: recent.at(-1)?.id ?? 0, written: plan.accepted ?? undefined };
    save(state);
    return state;
  };

  // Turns one at a time; a message during one is answered in the next.
  const answer = async () => {
    if (!chat) return;
    if (busy) return void (again = true);
    busy = true;
    try {
      const s = await ready();
      do {
        again = false;
        await turn(s);
      } while (again);
    } catch (e) {
      console.error((e as Error).message);
    } finally {
      busy = false;
    }
  };

  const planned = async (plan?: Plan) => {
    if (!cal) return;
    try {
      await calendar(await ready(), plan ?? ((await api("GET", `/api/plans/${today()}`)) as Plan));
    } catch (e) {
      console.error((e as Error).message);
    }
  };

  let retry = 1000;
  const follow = async () => {
    try {
      const ws = new WebSocket(`${CLOUD.replace(/^http/, "ws")}/api/live`, { headers: { Authorization: `Bearer ${await token()}` } } as any);
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      ws.onopen = () => {
        retry = 1000;
        // Whatever happened while no one was listening.
        answer();
        planned();
      };
      ws.onmessage = (e) => {
        let event: any;
        try {
          event = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (event.type === "chat" && event.message?.who === "matt") answer();
        if (event.type === "plan") planned(event.plan);
      };
      ws.onclose = () => {
        clearInterval(ping);
        setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
      };
    } catch {
      // Not signed in, or no network: try again later.
      setTimeout(follow, (retry = Math.min(retry * 2, 60_000)));
    }
  };
  follow();
}
