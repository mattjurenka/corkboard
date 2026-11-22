// An assistant resident (assistant.ts's assist), against a stand-in node and
// Worker, and an ssh that runs here and writes down what tmux was asked:
// its token and session env written into the guest, and the phone's chat
// pasted into its session, commands and all.   bun test fleet/fleetd
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

const dir = mkdtempSync(join(tmpdir(), "fleet-assist-"));
const ssh = join(dir, "ssh");
// tmux's load-buffer is what's pasted: each is a prompt.
writeFileSync(
  ssh,
  `#!/bin/sh
d=${dir}
if [ "$1" = tmux ]; then
  shift 3
  echo "$*" >> $d/tmux.log
  case "$1" in
    load-buffer) cat > $d/buffer; { cat $d/buffer; echo; echo ---; } >> $d/prompts ;;
    capture-pane) cat $d/screen 2>/dev/null ;;
  esac
else
  sh -c "$1"
fi
`,
);
chmodSync(ssh, 0o755);
const prompts = () => (existsSync(join(dir, "prompts")) ? readFileSync(join(dir, "prompts"), "utf8").split("\n---\n").filter(Boolean) : []);
// n prompts, the last of them sent.
const sent = (n: number) => prompts().length === n && readFileSync(join(dir, "tmux.log"), "utf8").trimEnd().endsWith("Enter");

type Message = { id: string; at: string; who: string; text: string; by_user?: boolean; delivered?: string | null };
// Two nodes' worth, at /a and /b: each assistant has a chat of its own.
const chats = new Map<string, Message[]>([["a", [{ id: "m1", at: "", who: "matt", text: "old news", by_user: true, delivered: "x" }]], ["b", []]]);
const minted: unknown[] = [];
const revoked: string[] = [];
// Taken back by the user: gone when it's marked passed on.
const takenBack = new Set<string>();
const events = new Set<ReadableStreamDefaultController<Uint8Array>>();
let sessionEnv: Record<string, string> = { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "it's" };

const node = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer nodeowner") return Response.json({ error: "who?" }, { status: 401 });
    const [, which, p] = url.pathname.match(/^\/(\w)\/api\/node(\/.*)$/) ?? [];
    const chat = chats.get(which);
    if (!chat) return Response.json({ error: "no" }, { status: 404 });
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    if (p === "/grants" && req.method === "POST") return (minted.push(body), Response.json({ token: `cbn_${minted.length}` }));
    if (p === "/grants" && req.method === "DELETE") return (revoked.push(body.token), Response.json({ revoked: true }));
    if (p === "/brains/pepper/session") return Response.json({ env: sessionEnv, model: "openrouter/x" });
    if (p === "/chat") {
      const after = url.searchParams.get("after");
      return Response.json(after === null ? chat : chat.slice(chat.findIndex((m) => m.id === after) + 1));
    }
    const d = p.match(/^\/chat\/(\w+)\/delivered$/);
    const m = d && !takenBack.has(d[1]) && chat.find((x) => x.id === d[1]);
    if (d && !m) return Response.json({ error: "no message" }, { status: 404 });
    if (m) return Response.json(Object.assign(m, { delivered: "now" }));
    if (p === "/day/events")
      return new Response(new ReadableStream({ start: (c) => void events.add(c), cancel: () => {} }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ error: "no" }, { status: 404 });
  },
});
const dayEvent = () => {
  for (const c of events) c.enqueue(new TextEncoder().encode("data: {}\n\n"));
};

// The Worker: only its /api/live, whose chat events are a reason to look.
const sockets = new Set<ServerWebSocket<unknown>>();
const worker = Bun.serve({
  port: 0,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/api/live" && req.headers.get("authorization") === "Bearer owner" && server.upgrade(req)) return;
    return Response.json({ error: "no" }, { status: 404 });
  },
  websocket: { open: (ws) => void sockets.add(ws), message() {}, close: (ws) => void sockets.delete(ws) },
});
const live = (event: object) => {
  for (const ws of sockets) ws.send(JSON.stringify(event));
};

async function until(ok: () => boolean, what: string, ms = 4000) {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`never: ${what}`);
}

const say = (which: string, m: Partial<Message> & { id: string }) => chats.get(which)!.push({ at: "", who: "matt", text: "", by_user: true, delivered: null, ...m });
const file = (f: string) => readFileSync(join(dir, f), "utf8");

beforeAll(async () => {
  process.env.CORKBOARD_CLOUD = `http://localhost:${worker.port}`;
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.CORKBOARD_STATE_DIR = join(dir, "state/corkboard");
  writeFileSync(join(dir, "node-token"), "nodeowner\n");
  const cloud = await import("../../bridge/cloud");
  if (!cloud.CLOUD.includes(String(worker.port))) throw new Error("the Worker isn't the test's");
  cloud.setRelay({ token: async () => "owner" });
  const { assist } = await import("./assistant");
  const tokenFile = join(dir, "node-token");
  assist("pepper-vm", "pepper", { ssh, tmuxSocket: "/run/t.sock", chat: true, memoryTokenFile: join(dir, "memory-token"), sessionEnvFile: join(dir, "session.env") }, { url: `http://localhost:${node.port}/a`, tokenFile });
  await until(() => sockets.size === 1, "the Worker's /api/live");
});
afterAll(() => {
  node.stop(true);
  worker.stop(true);
});

test("a first run mints its token on the node and writes it, and its session env, into the guest", async () => {
  // Kept once it's written.
  await until(() => existsSync(join(dir, "state/corkboard/pepper.json")) && !!JSON.parse(readFileSync(join(dir, "state/corkboard/pepper.json"), "utf8")).sessionEnv, "the session env");
  expect(minted).toEqual([{ scope: "brain", brain: "pepper", agent: "pepper-vm", resident: true }]);
  expect(file("memory-token")).toBe("cbn_1");
  const out = Bun.spawnSync(["sh", "-c", `. ${join(dir, "session.env")}; printf '%s|%s' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN"`]).stdout.toString();
  expect(out).toBe("https://openrouter.ai/api|it's");
  // What was in the chat before it is passed on never.
  const state = JSON.parse(readFileSync(join(dir, "state/corkboard/pepper.json"), "utf8"));
  expect(state).toMatchObject({ last: "m1", from: "node", nodeToken: "cbn_1" });
  expect(prompts()).toEqual([]);
});

test("the user's new messages are pasted into the session, the assistant's own aren't", async () => {
  say("a", { id: "m2", text: "what's on today?\nand tomorrow" });
  say("a", { id: "m3", text: "Here's your day.", who: "pepper", by_user: false });
  live({ type: "chat", message: { by_user: true } });
  await until(() => sent(1), "the prompt");
  expect(prompts()).toEqual(["[phone] what's on today?\nand tomorrow"]);
  const log = file("tmux.log").split("\n");
  expect(log.slice(-4, -1)).toEqual(["load-buffer -b phone -", "paste-buffer -p -d -b phone -t pepper", "send-keys -t pepper Enter"]);
  expect(chats.get("a")!.find((m) => m.id === "m2")!.delivered).toBe("now");
  expect(chats.get("a")!.find((m) => m.id === "m3")!.delivered).toBeNull();
  // The last passed on is the user's.
  await until(() => JSON.parse(readFileSync(join(dir, "state/corkboard/pepper.json"), "utf8")).last === "m2", "m2 passed");
});

test("a command runs as one, and the next prompt waits for its result to ask about it", async () => {
  writeFileSync(join(dir, "screen"), "❯ /mcp reconnect all\n  ⎿  Reconnected 2 of 2 MCP servers\n\n❯ \n");
  say("a", { id: "m4", text: "/mcp" });
  live({ type: "chat", message: { by_user: true } });
  await until(() => sent(3), "the command and what's asked of it");
  expect(prompts().slice(1)).toEqual(["/mcp reconnect all", "[phone] I ran /mcp reconnect all from my phone. Tell me in the chat what it showed."]);
  expect(file("tmux.log")).toContain("capture-pane -p -t pepper -S -40");
});

test("one taken back before it was passed on is skipped", async () => {
  say("a", { id: "m5", text: "never mind" });
  takenBack.add("m5");
  say("a", { id: "m6", text: "this one" });
  live({ type: "chat", message: { by_user: true } });
  await until(() => sent(4), "the next");
  expect(prompts().at(-1)).toBe("[phone] this one");
});

test("a day on, its token is replaced and the old one revoked; the session env is written only when it changes", async () => {
  const envAt = Bun.file(join(dir, "session.env")).lastModified;
  setSystemTime(new Date(Date.now() + 25 * 3600_000));
  try {
    live({ type: "chat", message: { by_user: true } });
    await until(() => revoked.length === 1, "the old token revoked");
    expect(revoked).toEqual(["cbn_1"]);
    expect(file("memory-token")).toBe("cbn_2");
    expect(Bun.file(join(dir, "session.env")).lastModified).toBe(envAt);
    sessionEnv = { ANTHROPIC_BASE_URL: "http://ollama.lan:11434" };
    setSystemTime(new Date(Date.now() + 2 * 3600_000));
    live({ type: "chat", message: { by_user: true } });
    await until(() => file("session.env").includes("ollama"), "the new session env");
    expect(file("session.env")).toBe("export ANTHROPIC_BASE_URL='http://ollama.lan:11434'\n");
    expect(minted.length).toBe(2);
  } finally {
    setSystemTime();
  }
});

test("one that has the chat on the node reads it at each of the node's day events", async () => {
  // A restart: it was already the node's, so it follows the node's events at once.
  writeFileSync(join(dir, "state/corkboard/work.json"), JSON.stringify({ last: "", from: "node" }));
  const { assist } = await import("./assistant");
  const before = prompts().length;
  assist("work-vm", "work", { ssh, tmuxSocket: "/run/w.sock", session: "w", chat: true }, { url: `http://localhost:${node.port}/b`, tokenFile: join(dir, "node-token") });
  await until(() => events.size === 1, "the day events");
  say("b", { id: "w1", text: "for work" });
  dayEvent();
  await until(() => sent(before + 1), "the work prompt");
  expect(prompts().at(-1)).toBe("[phone] for work");
  expect(file("tmux.log").trim().split("\n").at(-1)).toBe("send-keys -t w Enter");
  // No token file, no session env file: neither is asked for.
  expect(minted.length).toBe(2);
});
