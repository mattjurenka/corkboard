// An ACP session's transcript, which corkboard writes itself since ACP
// keeps none it can read: <dir>/<session id>.jsonl, a record a line in
// Claude Code's shape (user and assistant messages, text, tool_use and
// tool_result blocks), so bridge/transcript.ts gives the phone its items
// as it does for Claude Code's, and AskUserQuestion's questions with them.
// Usage is a record of its own ({ type: "usage", used, size, cost }), which
// the kind's context reader takes; Claude Code's readers pass it over.
//
// The agent's words come in chunks, and are written as one text block when
// something else comes or the turn ends. A tool call is written once its
// input is known (ACP's first tool_call often has none yet), its result once
// it's done.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// A tool call's content as text: what it said, and a diff's file.
function text(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if (c?.type === "content") return c.content?.type === "text" ? String(c.content.text ?? "") : c.content?.type ? `[${c.content.type}]` : "";
      if (c?.type === "diff") return `edited ${c.path ?? "a file"}`;
      if (c?.type === "terminal") return "[terminal]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// A tool's input: Codex wraps an MCP call's as { server, tool, arguments }.
function input(raw: any): unknown {
  if (raw && typeof raw === "object" && typeof raw.server === "string" && typeof raw.tool === "string" && "arguments" in raw) return raw.arguments ?? {};
  return raw;
}

// What a tool gave back when its content is empty: Codex's MCP result is
// rawOutput { result: { content: [...] }, error }.
function output(raw: any): string {
  if (!raw || typeof raw !== "object") return "";
  if (raw.error) return typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error);
  const content = raw.result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type ? `[${c.type}]` : "")).filter(Boolean).join("\n");
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "object" && Object.keys(v as object).length === 0);

export class Transcript {
  readonly path: string;
  private said = "";
  // Tool calls by id: their name, whether their call is written, its input,
  // and a command's output and exit code so far.
  private calls = new Map<string, { name: string; written: boolean; input: unknown; title?: string; out: string; exit?: number | null }>();

  constructor(
    dir: string,
    readonly session: string,
    private names: (tool: string, id?: string) => string = (t) => t,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${session}.jsonl`);
  }

  private write(r: object) {
    appendFileSync(this.path, JSON.stringify({ uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: this.session, ...r }) + "\n", { mode: 0o600 });
  }

  // The agent's words not written yet, which a view draws as they come.
  get saying(): string {
    return this.said;
  }

  private message(type: "user" | "assistant", content: unknown) {
    this.write({ type, message: { role: type, content } });
  }

  // The agent's words so far, written.
  private flush() {
    const t = this.said.trim();
    this.said = "";
    if (t) this.message("assistant", [{ type: "text", text: t }]);
  }

  you(text: string) {
    this.flush();
    this.message("user", text);
  }

  update(u: any) {
    switch (u?.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") this.said += String(u.content.text ?? "");
        return;
      case "tool_call":
      case "tool_call_update": {
        this.flush();
        const id = String(u.toolCallId ?? "");
        let c = this.calls.get(id);
        if (!c) this.calls.set(id, (c = { name: this.names(String(u.name ?? u.title ?? "tool"), id), written: false, input: undefined, out: "" }));
        if (!empty(u.rawInput)) c.input = input(u.rawInput);
        if (u.title && u.title !== c.name) c.title = String(u.title);
        // Codex gives a command's output and exit only in _meta, for a
        // terminal corkboard never made.
        const delta = u._meta?.terminal_output_delta?.data;
        if (typeof delta === "string") c.out += delta;
        if (u._meta?.terminal_exit) c.exit = u._meta.terminal_exit.exit_code;
        // opencode's: a command that failed still completed, its exit beside.
        if (typeof u.rawOutput?.metadata?.exit === "number") c.exit = u.rawOutput.metadata.exit;
        const done = u.status === "completed" || u.status === "failed";
        // opencode's pending call has only some of its input (its cwd).
        if (!c.written && ((c.input !== undefined && u.status !== "pending") || done)) {
          c.written = true;
          // Codex's read, search or list command has no input, only its title.
          this.message("assistant", [{ type: "tool_use", id, name: c.name, input: c.input ?? (c.title ? { description: c.title } : {}) }]);
        }
        if (done) {
          this.calls.delete(id);
          const out = c.out.trimEnd() || text(u.content) || output(u.rawOutput);
          const failed = u.status === "failed" || (c.exit !== undefined && c.exit !== 0);
          this.message("user", [{ type: "tool_result", tool_use_id: id, content: out, is_error: failed }]);
        }
        return;
      }
    }
  }

  usage(u: { used: number; size: number; cost?: unknown }) {
    this.write({ type: "usage", ...u });
  }

  // The turn's over: what's left of its words, and its tokens if it says.
  turn(tokens?: unknown) {
    this.flush();
    if (tokens && typeof tokens === "object") this.write({ type: "usage", tokens });
  }
}
