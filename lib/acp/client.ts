// An agent over ACP (the Agent Client Protocol, agentclientprotocol.com):
// JSON-RPC, a message a line, on the agent's stdio, with corkboard as its
// client (.agent/plans/agents.md, stage 5). One process, one session: it
// starts the agent, opens a session (session/new, or session/load to go on
// with one), sends prompts and cancels them, answers the agent's permission
// requests through `permission`, and turns its session/updates into
// corkboard's events (hooks/session.lua's names) and into a transcript in
// Claude Code's record shape (transcript.ts), which the phone, usage and
// context read as they read Claude Code's.
//
// No file system or terminal of the client's is offered: the agent uses its
// own tools, as it does in its TUI.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { Transcript } from "./transcript";

// An MCP server, as session/new takes one.
export type McpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

// How a kind runs: its argv and environment, and the MCP servers to hand
// session/new (a kind can give them in its own config instead, with none
// here), given its toolCallId too. files: what it wrote for the agent,
// files or directories, removed when the agent ends.
// quiet: a session/update the kind's agent sends that isn't the conversation's.
// settle: ms to wait after the session opens before it's ready, for an agent
// whose MCP tools join the session a moment after it says it's open.
// meta: the session/new (and session/load) _meta the kind's agent reads.
// auth: the authenticate method to sign in with before the session, given
// the env the kind's spec ends up with (a fleet slot's credential's too).
export type Spec = {
  command: string[];
  env?: Record<string, string>;
  mcpServers?: McpServer[];
  names?: (tool: string, id?: string) => string;
  files?: string[];
  quiet?: (u: any) => boolean;
  settle?: number;
  meta?: object;
  auth?: (env: Record<string, string>) => string | undefined;
};

// corkboard's event, as agents.lua's hook takes it.
export type Event = {
  event: "start" | "turn" | "tool" | "tool_done" | "permission" | "settled" | "notice";
  session?: string;
  transcript?: string;
  tool_name?: string;
  tool_use_id?: string;
  // A permission's tool, in a line.
  question?: string;
  // settled's: why the turn ended (ACP's stopReason).
  stop?: string;
};

// What the agent asks permission for, and the answers it takes.
export type Permission = {
  tool: { id: string; name: string; title: string; input?: unknown; content?: unknown };
  options: { optionId: string; kind: string; name: string }[];
};

// What the session's context and cost are, as the agent last said.
export type Usage = { used: number; size: number; cost?: { amount: number; currency: string } };

export type Options = {
  spec: Spec;
  cwd: string;
  // Where its transcript goes: <dir>/<session id>.jsonl.
  dir: string;
  event: (e: Event) => void;
  // Every session/update, whole, for a view of the conversation.
  update?: (u: any) => void;
  // The option picked, or null to refuse. Unanswered when the session ends.
  permission?: (p: Permission) => Promise<string | null>;
  // The agent's stderr and how it ended.
  log?: (line: string) => void;
  exit?: (code: number | null) => void;
};

type Waiting = { resolve: (v: any) => void; reject: (e: Error) => void };

export class AcpSession {
  private proc: ChildProcess;
  private next = 0;
  private waiting = new Map<number, Waiting>();
  private rest = "";
  private loading = false;
  private transcript?: Transcript;
  // A turn's tool calls, by id: what they're called, for tool_done.
  private tools = new Map<string, string>();
  id?: string;
  capabilities: any = {};
  usage?: Usage;
  // Whether a prompt is running.
  busy = false;
  closed = false;

  constructor(private o: Options) {
    const [exe, ...args] = o.spec.command;
    this.proc = spawn(exe, args, { cwd: o.cwd, env: { ...process.env, ...o.spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => o.log?.(chunk));
    this.proc.on("error", (err) => this.ended(err));
    this.proc.on("exit", (code) => {
      this.ended(new Error(`${exe} exited${code === null ? "" : ` with status ${code}`}`));
      o.exit?.(code);
    });
    this.proc.stdin!.on("error", () => {});
  }

  get transcriptPath(): string | undefined {
    return this.transcript?.path;
  }

  // What it's saying that the transcript doesn't have yet.
  get saying(): string {
    return this.transcript?.saying ?? "";
  }

  // The agent up and a session open: a new one, or resume's again.
  async start(resume?: string): Promise<string> {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    this.capabilities = init?.agentCapabilities ?? {};
    const method = this.o.spec.auth?.(this.o.spec.env ?? {});
    if (method) await this.request("authenticate", { methodId: method });
    const session = { cwd: this.o.cwd, mcpServers: this.o.spec.mcpServers ?? [], ...(this.o.spec.meta && { _meta: this.o.spec.meta }) };
    if (resume) {
      if (!this.capabilities.loadSession) throw new Error("this agent can't go on with a session");
      // What it replays of the session is in the transcript already.
      this.loading = true;
      try {
        await this.request("session/load", { sessionId: resume, ...session });
      } finally {
        this.loading = false;
      }
      this.id = resume;
    } else {
      const got = await this.request("session/new", session);
      if (typeof got?.sessionId !== "string") throw new Error("the agent opened no session");
      this.id = got.sessionId;
    }
    if (this.o.spec.settle) await new Promise((r) => setTimeout(r, this.o.spec.settle));
    this.transcript = new Transcript(this.o.dir, this.id!, this.o.spec.names);
    this.o.event({ event: "start", session: this.id, transcript: this.transcript.path });
    return this.id!;
  }

  // A turn: resolves with its stopReason once it's over.
  async prompt(text: string): Promise<string> {
    if (!this.id) throw new Error("no session yet");
    if (this.busy) throw new Error("it's still on the last prompt");
    this.busy = true;
    this.transcript!.you(text);
    this.o.event({ event: "turn", session: this.id, transcript: this.transcript!.path });
    try {
      const got = await this.request("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] });
      const stop = String(got?.stopReason ?? "end_turn");
      this.transcript!.turn(got?.usage);
      return stop;
    } catch (err) {
      this.transcript!.turn();
      throw err;
    } finally {
      this.busy = false;
      this.tools.clear();
      if (!this.closed) this.o.event({ event: "settled", session: this.id, transcript: this.transcript!.path });
    }
  }

  // The turn stopped; its prompt resolves with "cancelled".
  cancel() {
    if (this.id && this.busy) this.notify("session/cancel", { sessionId: this.id });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.transcript?.turn();
    this.proc.kill();
    this.forget();
  }

  // What the spec wrote for it.
  private forget() {
    for (const f of this.o.spec.files ?? []) rmSync(f, { force: true, recursive: true });
  }

  private ended(err: Error) {
    this.closed = true;
    this.forget();
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  private write(msg: object) {
    if (!this.proc.stdin!.writable) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("the agent has ended"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  private read(chunk: string) {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.o.log?.(line + "\n");
        continue;
      }
      if (msg.method) this.handle(msg);
      else if (this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id)!;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    }
  }

  // The agent's requests and notifications.
  private handle(msg: any) {
    const answer = (result: unknown) => this.write({ id: msg.id, result });
    const refuse = (message: string) => this.write({ id: msg.id, error: { code: -32601, message } });
    if (msg.method === "session/update") return this.updated(msg.params?.update);
    if (msg.method === "session/request_permission") {
      const p = msg.params ?? {};
      const call = p.toolCall ?? {};
      const name = this.tools.get(call.toolCallId) ?? this.name(call.name ?? call.title ?? "tool", call.toolCallId);
      const permission: Permission = {
        tool: { id: String(call.toolCallId ?? ""), name, title: String(call.title ?? name), input: call.rawInput, content: call.content },
        options: Array.isArray(p.options) ? p.options : [],
      };
      this.o.event({ event: "permission", session: this.id, transcript: this.transcriptPath, tool_name: name, tool_use_id: permission.tool.id, question: `${name}: ${permission.tool.title}` });
      const asked = this.o.permission ? this.o.permission(permission) : Promise.resolve(null);
      asked.then(
        (optionId) => answer({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } }),
        () => answer({ outcome: { outcome: "cancelled" } }),
      );
      return;
    }
    if (msg.id !== undefined) refuse(`corkboard doesn't do ${msg.method}`);
  }

  private name(raw: string, id?: unknown): string {
    return this.o.spec.names ? this.o.spec.names(raw, id === undefined ? undefined : String(id)) : raw;
  }

  private updated(u: any) {
    if (!u || typeof u.sessionUpdate !== "string" || this.o.spec.quiet?.(u)) return;
    this.o.update?.(u);
    if (u.sessionUpdate === "usage_update") {
      const usage: Usage = { used: Number(u.used) || 0, size: Number(u.size) || 0, ...(u.cost && { cost: u.cost }) };
      this.usage = usage;
      if (!this.loading) this.transcript?.usage(usage);
      return;
    }
    if (this.loading || !this.transcript) return;
    this.transcript.update(u);
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const id = String(u.toolCallId ?? "");
      const known = this.tools.get(id);
      const name = known ?? this.name(String(u.name ?? u.title ?? "tool"), id);
      const base = { session: this.id, transcript: this.transcript.path, tool_name: name, tool_use_id: id };
      if (!known) {
        this.tools.set(id, name);
        // corkboard-ui's ask says it's asking itself (corkboard.questions).
        if (name !== "AskUserQuestion") this.o.event({ event: "tool", ...base });
      }
      if ((u.status === "completed" || u.status === "failed") && name !== "AskUserQuestion") this.o.event({ event: "tool_done", ...base });
    }
  }
}
