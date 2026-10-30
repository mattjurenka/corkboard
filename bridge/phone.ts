// What corkboard's phone app (android/) needs from this machine, done by
// one bridge on it (a lock file) while it follows the user's live socket:
// the calendar, for a plan accepted on the phone. Accepting in the day
// plan's window writes the Claude calendar with `dayplan apply` first, which
// is what opens the dayplan gate (plan.lua's accept); the phone can't, so a
// plan accepted anywhere but here is written now, the same way. Accepts made
// through this machine's bridges are marked (acceptedHere) so they aren't
// written twice. Needs dayplan.
//
// The phone's chat is Pepper's own, on the droplet (fleet/pepper/pepperd.ts).
//
// CORKBOARD_PHONE=0 turns it off.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLOUD, token } from "./cloud";

const DAYPLAN = process.env.CORKBOARD_DAYPLAN ?? "dayplan";
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard");
const STATE = join(STATE_DIR, "phone.json");
const LOCK = join(STATE_DIR, "phone.lock");
const HERE = join(STATE_DIR, "accepted-here");

// The accept whose calendar is written.
type State = { written?: string };
type Block = { id: string; start: number; stop: number; title: string; kind: string; desc?: string };
type Plan = { date: string; accepted: string | null; day: { blocks: Block[] } };

// The plan's day, which turns over at 4am (cloud/src/plans.ts).
const today = () => new Intl.DateTimeFormat("en-CA").format(new Date(Date.now() - 4 * 3600_000));

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
  if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
  return out;
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
  if (!Bun.which(DAYPLAN) || !lock()) return;
  let state: State | undefined = load();

  // A first run writes no plan already accepted.
  const ready = async (): Promise<State> => {
    if (state) return state;
    const plan = (await api("GET", `/api/plans/${today()}`)) as Plan;
    state = { written: plan.accepted ?? undefined };
    save(state);
    return state;
  };

  const planned = async (plan?: Plan) => {
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
        planned();
      };
      ws.onmessage = (e) => {
        let event: any;
        try {
          event = JSON.parse(String(e.data));
        } catch {
          return;
        }
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
