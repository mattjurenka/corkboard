// A slot's agent when its template's kind is an ACP one (fleet/guest/slot.nix
// runs this where it runs `claude -p` for Claude Code), with the outbox
// written as Claude Code's would be, so fleetd reads it the same:
//
//   bun acp.ts <kind> task    [--mcp-config <file>]... [--prompt-file <file>]
//   bun acp.ts <kind> session [--mcp-config <file>]... [--prompt-file <file>]
//
// task: one turn on /mnt/share/task.md; its last words are result.json's
// result. session: each message fleetd puts in /mnt/share/inbox/ (sessions.ts's
// stream-json lines: a user message is a turn, an interrupt cancels the one
// it's on, END finishes once it's done), each turn's end a result line in
// events.jsonl. Either way its transcript is in outbox/projects/acp/, where
// fleetd follows a session's.
//
// The kind's credential, /mnt/share/<kind>-credential, is KEY=value lines
// for its environment: GEMINI_API_KEY=... for gemini, OPENAI_API_KEY=... for
// codex (given to codex-acp as its gateway, OpenAI's, since the adapter
// only takes that key through a login: lib/acp/codex.ts). Every permission it asks
// is allowed, as Claude Code runs here with --dangerously-skip-permissions.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpSession, type Permission } from "../../lib/acp/client";
import { KINDS } from "../../lib/acp/kinds";

const SHARE = process.env.FLEET_SHARE ?? "/mnt/share";
const OUT = process.env.FLEET_OUTBOX ?? "/mnt/outbox";

// KEY=value lines, # comments and blank lines skipped.
export function credential(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// The credential's lines as kind's environment.
export function credentialEnv(kind: string, text: string): Record<string, string> {
  const env = credential(text);
  if (kind === "codex" && env.OPENAI_API_KEY && !env.DEFAULT_AUTH_REQUEST) {
    const gateway = { baseUrl: "https://api.openai.com/v1", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, providerName: "openai" };
    env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "gateway", _meta: { gateway } });
  }
  return env;
}

// The answer that lets it go on: always, else once, else the first.
export function allow(p: Permission): string | null {
  const by = (kind: string) => p.options.find((o) => o.kind === kind)?.optionId;
  return by("allow_always") ?? by("allow_once") ?? p.options[0]?.optionId ?? null;
}

// What a line in the inbox asks for.
export type Message = { prompt: string } | { interrupt: true } | { end: true } | null;
export function message(line: string): Message {
  if (line.trim() === "END") return { end: true };
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m?.type === "control_request" && m.request?.subtype === "interrupt") return { interrupt: true };
  if (m?.type !== "user") return null;
  const c = m.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
  return text ? { prompt: text } : null;
}

function args(argv: string[]) {
  const [kind, mode, ...rest] = argv;
  const mcp: string[] = [];
  let prompt: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--mcp-config") mcp.push(rest[++i]);
    else if (rest[i] === "--prompt-file") prompt = rest[++i];
  }
  return { kind, mode, mcp, prompt };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(argv: string[]): Promise<number> {
  const o = args(argv);
  const make = KINDS[o.kind];
  if (!make || (o.mode !== "task" && o.mode !== "session")) {
    console.error(`fleet-acp: usage: <${Object.keys(KINDS).join("|")}> task|session [--mcp-config file]... [--prompt-file file]`);
    return 2;
  }
  const cred = join(SHARE, `${o.kind}-credential`);
  const spec = make({
    dir: join(process.env.HOME ?? "/tmp", ".corkboard-acp"),
    name: "fleet",
    prompt: o.prompt && existsSync(o.prompt) ? readFileSync(o.prompt, "utf8") : undefined,
    mcp: o.mcp,
  });
  if (existsSync(cred)) spec.env = { ...spec.env, ...credentialEnv(o.kind, readFileSync(cred, "utf8")) };

  const events = join(OUT, "events.jsonl");
  const dir = join(OUT, "projects", "acp");
  mkdirSync(dir, { recursive: true });
  // A turn's words, which are its result.
  let said = "";
  let exited: number | null | undefined;
  const session = new AcpSession({
    spec,
    cwd: process.cwd(),
    dir,
    event: () => {},
    update: (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") said += u.content.text;
      // Words after a tool are the next thing it says, not more of the last.
      else if (u.sessionUpdate === "tool_call") said = "";
    },
    permission: async (p) => allow(p),
    log: (line) => process.stderr.write(line),
    exit: (code) => (exited = code),
  });

  const turn = async (text: string) => {
    said = "";
    try {
      const stop = await session.prompt(text);
      return { result: said.trim(), stop_reason: stop, is_error: false };
    } catch (err) {
      return { result: (err as Error).message, stop_reason: "error", is_error: true };
    }
  };

  try {
    await session.start();
  } catch (err) {
    writeFileSync(join(OUT, "result.json"), JSON.stringify({ result: `${o.kind} didn't start: ${(err as Error).message}`, is_error: true }) + "\n");
    session.close();
    return 1;
  }

  if (o.mode === "task") {
    const r = await turn(readFileSync(join(SHARE, "task.md"), "utf8"));
    writeFileSync(join(OUT, "result.json"), JSON.stringify(r) + "\n");
    session.close();
    return r.is_error ? 1 : 0;
  }

  // A session: messages in the order sent, a turn at a time.
  appendFileSync(events, JSON.stringify({ type: "system", subtype: "init", session_id: session.id, agent: o.kind }) + "\n");
  const queue: string[] = [];
  let ending = false;
  let last: object = {};
  let running: Promise<void> | undefined;
  const next = () => {
    if (running || queue.length === 0) return;
    const text = queue.shift()!;
    running = turn(text).then((r) => {
      last = r;
      appendFileSync(events, JSON.stringify({ type: "result", ...r }) + "\n");
      running = undefined;
      next();
    });
  };
  for (let n = 0; ; ) {
    if (exited !== undefined) break;
    const f = join(SHARE, "inbox", String(n));
    if (!existsSync(f)) {
      if (ending && !running && queue.length === 0) break;
      await sleep(500);
      continue;
    }
    n++;
    const m = message(readFileSync(f, "utf8"));
    if (!m) continue;
    if ("end" in m) ending = true;
    else if ("interrupt" in m) session.cancel();
    else {
      queue.push(m.prompt);
      next();
    }
  }
  await running;
  writeFileSync(join(OUT, "result.json"), JSON.stringify(last) + "\n");
  session.close();
  return exited ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
