// The agents this machine can run (nvim/lua/corkboard/agent/'s kinds), for
// the page's Agents screen (web/src/components/Agents.tsx): which are on
// PATH, where each comes from, and its own installer run here where it has
// one that needs nothing else. corkboard starts with none of them; the
// screen is how the user gets the one they want.
//
//   GET  /agents          { agents, path, installing, failed }
//   POST /agents/install  { name }: started, the same answer; GET says how it went

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const WIN = process.platform === "win32";

type Kind = {
  name: string;
  label: string;
  // What must be on PATH (agent/<name>.lua's exe).
  exe: string;
  url: string;
  // What to do after it, or instead of it where corkboard can't run one.
  note?: string;
  // Its installer as the user would type it, and as it is run.
  install?: () => { command: string; argv: string[] } | undefined;
};

const sh = (command: string) => ({ command, argv: ["/bin/bash", "-c", command] });
const powershell = (command: string) => ({ command, argv: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] });
const has = (exe: string) => !!Bun.which(exe, { PATH: process.env.PATH ?? "" });

// Claude Code first: the default where it's there (agent/init.lua).
const KINDS: Kind[] = [
  {
    name: "claude",
    label: "Claude Code",
    exe: "claude",
    url: "https://claude.com/claude-code",
    // Its own installer (code.claude.com/docs/en/setup), into ~/.local/bin
    // on every system.
    install: () => (WIN ? powershell("irm https://claude.ai/install.ps1 | iex") : sh("curl -fsSL https://claude.ai/install.sh | bash")),
  },
  {
    name: "codex",
    label: "Codex",
    exe: "codex-acp",
    url: "https://github.com/agentclientprotocol/codex-acp",
    note: "needs codex-acp, and codex signed in (codex login)",
  },
  {
    name: "opencode",
    label: "opencode",
    exe: "opencode",
    url: "https://opencode.ai",
    // Its own installer, into ~/.opencode/bin; on Windows, npm's package.
    install: () => (!WIN ? sh("curl -fsSL https://opencode.ai/install | bash") : has("npm") ? powershell("npm install -g opencode-ai") : undefined),
  },
  {
    name: "agy",
    label: "Antigravity",
    exe: "agy",
    url: "https://antigravity.google",
    note: "needs the agy command, signed in with Google",
  },
];

// Where the installers put things, which a PATH from before them may not
// have: in front, so a session started next finds what was just installed.
export function refreshPath(): string {
  const home = homedir();
  const dirs = [join(home, ".local", "bin"), join(home, ".opencode", "bin"), ...(WIN && process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : [])];
  const have = (process.env.PATH ?? "").split(delimiter);
  const more = dirs.filter((d) => !have.includes(d) && existsSync(d));
  if (more.length) process.env.PATH = [...more, ...have].filter(Boolean).join(delimiter);
  return process.env.PATH ?? "";
}

// One installer at a time; the last one's failure is kept for the page
// until the next starts.
let installing: string | undefined;
let failed: { name: string; error: string; output: string } | undefined;

export type Run = (argv: string[]) => Promise<{ code: number; output: string }>;
const run: Run = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env, windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: out + err };
};

function view() {
  const path = refreshPath();
  return {
    agents: KINDS.map((k) => ({ name: k.name, label: k.label, url: k.url, note: k.note ?? null, installed: has(k.exe), command: k.install?.()?.command ?? null })),
    path,
    installing: installing ?? null,
    failed: failed ?? null,
  };
}

async function install(kind: Kind, argv: string[], runs: Run) {
  installing = kind.name;
  failed = undefined;
  let error: string | undefined;
  let output = "";
  try {
    const done = await runs(argv);
    output = done.output;
    if (done.code !== 0) error = `exit ${done.code}`;
  } catch (e) {
    error = (e as Error).message;
  }
  refreshPath();
  if (!error && !has(kind.exe)) error = `${kind.exe} still isn't on PATH`;
  // The last of what it said, which is where an installer says why.
  if (error) failed = { name: kind.name, error, output: output.trim().split(/\r?\n/).slice(-12).join("\n") };
  installing = undefined;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The page's calls, already let in (server.ts checks its origin and token).
export async function agents(req: Request, path: string, runs: Run = run): Promise<Response> {
  if (path === "/agents" && req.method === "GET") return json(view());
  if (path !== "/agents/install") return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  const { name } = (await req.json().catch(() => ({}))) as { name?: unknown };
  const kind = KINDS.find((k) => k.name === name);
  if (!kind) return json({ error: `no agent called ${String(name)}` }, 400);
  if (installing) return json({ error: `${installing} is being installed` }, 409);
  const how = kind.install?.();
  if (!how) return json({ error: `${kind.label} has no installer corkboard can run; see ${kind.url}` }, 400);
  void install(kind, how.argv, runs);
  return json(view());
}
