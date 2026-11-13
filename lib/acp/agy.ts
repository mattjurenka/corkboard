// Antigravity CLI as an ACP agent (`agy acp`, verified against 1.5.3,
// nixpkgs', with a real turn on a Google AI Plus login). It took over
// Gemini CLI's personal sign-in, which Google stopped serving on 2026-06-18.
// Nothing is written for it, and ~/.gemini/antigravity-cli is left as it is:
//
// - corkboard's prompt goes in session/new's (and session/load's)
//   _meta.antigravity.systemPrompt.append, which initialize advertises:
//   added to agy's own prompt, not in its place. A top-level
//   _meta.systemPrompt is ignored.
// - The MCP servers go in session/new as ACP's, stdio and HTTP alike (HTTP
//   with its headers, no --process-per-session needed in 1.5.3). Their tools
//   are registered up front as mcp_<server>_<tool> and run without asking.
// - Auth is the user's own (`agy` once, signed in with Google; the login is
//   in the keyring, so HOME doesn't matter) unless a key is given:
//   GEMINI_API_KEY, signed in with by `authenticate { methodId:
//   "gemini-api-key" }` before the session, which only that session uses.
//   A key in the user's own environment is left alone, so it never takes the
//   place of their plan.
// - A Gemini brain's key signs it in; agy's own model either way, since its
//   ids (gemini-3.8-flash-high) aren't the API's.
//
// Seen, not handled here: each tool call has its name in `name` (run_command,
// edit_file, mcp_corkboard_list_cards) beside a title of what it does, and a
// toolSummary agy adds to its input; a shell command asks permission (allow,
// deny), an edit in the workspace doesn't; no usage_update, the prompt's
// result has ACP's usage; and session/load replays the history before it
// answers, as opencode's does, with the prompt kept.

import { readMcp, type ClaudeMcp } from "./opencode";
import type { McpServer, Spec } from "./client";
import type { Model } from "../think";

// The brain's key when its model is Gemini's.
export function key(m: Model | undefined, k?: string): string | undefined {
  if (!m || m.provider !== "openai" || new URL(m.base).hostname !== "generativelanguage.googleapis.com") return undefined;
  return k;
}

// A tool's name in Claude Code's: mcp_<server>_<tool> as
// mcp__<server>__<tool>, corkboard-ui's ask as AskUserQuestion.
export function names(servers: string[]): (tool: string) => string {
  // Longest first, so corkboard-memory_x isn't corkboard's memory-x.
  const known = [...servers].sort((a, b) => b.length - a.length);
  return (name) => {
    const s = known.find((s) => name.startsWith(`mcp_${s}_`));
    if (!s) return name;
    const tool = name.slice(`mcp_${s}_`.length);
    return s === "corkboard-ui" && tool === "ask" ? "AskUserQuestion" : `mcp__${s}__${tool}`;
  };
}

export type AgyOptions = {
  // corkboard's system prompt.
  prompt?: string;
  // Claude Code --mcp-config values, and ACP-shaped servers (corkboard-ui).
  mcp?: ClaudeMcp[];
  servers?: McpServer[];
  model?: Model;
  key?: string;
};

export function agy(o: AgyOptions): Spec {
  const servers: McpServer[] = [];
  for (const v of o.mcp ?? []) {
    for (const [name, e] of Object.entries(readMcp(v))) {
      if (e.type === "http" || e.type === "sse" || (!e.command && e.url)) servers.push({ type: "http", name, url: e.url!, headers: Object.entries(e.headers ?? {}).map(([name, value]) => ({ name, value })) });
      else servers.push({ name, command: e.command!, args: e.args ?? [], env: Object.entries(e.env ?? {}).map(([name, value]) => ({ name, value })) });
    }
  }
  // corkboard-ui's last, as the others take it.
  for (const s of o.servers ?? []) servers.push(s);
  const k = key(o.model, o.key);
  return {
    command: ["agy", "acp"],
    env: k ? { GEMINI_API_KEY: k } : {},
    mcpServers: servers,
    meta: o.prompt ? { antigravity: { systemPrompt: { append: o.prompt } } } : undefined,
    auth: (env) => (env.GEMINI_API_KEY ? "gemini-api-key" : undefined),
    names: names(servers.map((s) => s.name)),
  };
}
