// A Claude Code session's conversation, from its log (the transcript JSONL
// beside ~/.claude/projects), as the phone draws it (remote.ts): what you
// said, what Claude said, and each tool it used with how that went. Its
// thinking, subagents' own work and the log's bookkeeping are left out.
//
// Each item has the id of the record it came from (and the block's index),
// so a log read again gives the same ids; a tool's result is an item of its
// own that names the call, which the phone puts under it.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type Item =
  | { id: string; at: string; kind: "you" | "claude"; text: string }
  | { id: string; at: string; kind: "tool"; tool: string; call: string; detail: string; options?: string[][] }
  | { id: string; at: string; kind: "result"; call: string; text: string; error: boolean };

const TEXT = 6000;
const RESULT = 600;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// What Claude Code adds to a message that isn't what you typed.
const unwrap = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

// A tool call in a line: what it was about.
function detail(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  if (name === "Bash") return str("description") ?? str("command") ?? "";
  if (name === "AskUserQuestion" && Array.isArray(input.questions)) return input.questions.map((q: any) => q?.question ?? "").join("\n");
  const d = str("file_path") ?? str("notebook_path") ?? str("path") ?? str("description") ?? str("pattern") ?? str("url") ?? str("query") ?? str("prompt") ?? str("skill");
  if (d) return d;
  return Object.values(input).find((v) => typeof v === "string") as string | undefined ?? "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).join("\n");
  return "";
}

// The items in one record of the log.
export function items(r: any): Item[] {
  if (!r || r.isSidechain || r.isMeta || !r.message || (r.type !== "user" && r.type !== "assistant")) return [];
  const at = typeof r.timestamp === "string" ? r.timestamp : "";
  const content = r.message.content;
  if (r.type === "user" && typeof content === "string") {
    const text = unwrap(content);
    return text ? [{ id: r.uuid, at, kind: "you", text: cut(text, TEXT) }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: any, i: number): Item[] => {
    const id = `${r.uuid}:${i}`;
    if (b?.type === "text" && typeof b.text === "string") {
      const text = r.type === "user" ? unwrap(b.text) : b.text.trim();
      return text ? [{ id, at, kind: r.type === "user" ? "you" : "claude", text: cut(text, TEXT) }] : [];
    }
    if (b?.type === "tool_use") {
      const input = (b.input ?? {}) as Record<string, unknown>;
      // A question's options, each question's labels in order, for buttons.
      const options =
        b.name === "AskUserQuestion" && Array.isArray(input.questions)
          ? input.questions.map((q: any) => (Array.isArray(q?.options) ? q.options.map((o: any) => String(o?.label ?? "")) : []))
          : undefined;
      return [{ id, at, kind: "tool", tool: String(b.name), call: String(b.id), detail: cut(detail(String(b.name), input), 300), ...(options && { options }) }];
    }
    if (b?.type === "tool_result") {
      return [{ id, at, kind: "result", call: String(b.tool_use_id), text: cut(resultText(b.content).trim(), RESULT), error: b.is_error === true }];
    }
    return [];
  });
}

// A log followed as it grows: each read gives the items written since the
// last, from whole lines only.
export class Follower {
  private offset = 0;
  private rest = "";

  constructor(readonly path: string) {}

  read(): Item[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    // Rewritten from the start (a compaction can do it): read it again.
    if (size < this.offset) (this.offset = 0), (this.rest = "");
    if (size === this.offset) return [];
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.rest + buf.toString("utf8")).split("\n");
      this.rest = lines.pop() ?? "";
      return lines.flatMap((l) => {
        try {
          return items(JSON.parse(l));
        } catch {
          return [];
        }
      });
    } finally {
      closeSync(fd);
    }
  }
}
