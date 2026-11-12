// Gemini CLI as an ACP agent (`gemini --acp`, verified against 0.47.0,
// nixpkgs', with a stand-in Gemini API at GOOGLE_GEMINI_BASE_URL):
// corkboard's system prompt and MCP servers go in a settings file at
// GEMINI_CLI_SYSTEM_DEFAULTS_PATH, the lowest layer, under the user's own
// ~/.gemini/settings.json and the project's.
//
// - The prompt is a GEMINI.md in a directory of its own, in
//   `context.includeDirectories` with `loadMemoryFromIncludeDirectories`:
//   it's added to the session's context beside the project's GEMINI.md.
//   GEMINI_SYSTEM_MD would replace Gemini's whole system prompt.
// - The MCP servers are settings `mcpServers`, `trust`ed so their tools
//   don't ask first; session/new's take no `trust`. The workspace is
//   trusted (GEMINI_CLI_TRUST_WORKSPACE): in an untrusted folder Gemini
//   starts no MCP server at all. A tool is mcp_<server>_<tool>, and its
//   tool_call's title "<tool> (<server> MCP Server)"; names() gives either
//   back in Claude Code's mcp__<server>__<tool> (and corkboard-ui's ask as
//   AskUserQuestion). A built-in's title is what it does ("echo hi"), its
//   name only in the toolCallId, "<name>__<name>_<ms>_<n>".
// - Auth is the user's own (their Google login in ~/.gemini) unless a key
//   is given: GEMINI_API_KEY, with `security.auth.selectedType` set, which
//   session/load needs (an env key alone only does for session/new). A
//   user's own selectedType still wins.
// - A brain's model only when it's Gemini's: Gemini CLI speaks Google's
//   API, not OpenAI's, so a model at generativelanguage.googleapis.com
//   runs as GEMINI_MODEL with the key; any other leaves Gemini's own.
//
// Seen, not handled here: no usage_update (the prompt's result has
// _meta.quota.token_count, which the client writes as the turn's tokens,
// summed over its model calls, so no context); a tool_call has no rawInput, an MCP
// call's input is its content as JSON text; MCP calls and edits ask
// permission (proceed_always_server, proceed_always_tool, proceed_once,
// cancel), a harmless shell command doesn't; and session/load, though
// advertised, writes a fresh start over the session before it reads it,
// so it answers "No previous sessions found".

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromAcp, readMcp, type ClaudeMcp } from "./opencode";
import type { McpServer, Spec } from "./client";
import type { Model } from "../think";

type Entry = ReturnType<typeof readMcp>[string];

// Gemini's settings entry for one.
function entry(e: Entry): object {
  const headers = e.headers ?? {};
  if (e.type === "sse") return { url: e.url, headers, trust: true };
  if (e.type === "http" || (!e.command && e.url)) return { httpUrl: e.url, headers, trust: true };
  return { command: e.command, args: e.args ?? [], env: e.env ?? {}, trust: true };
}

// The brain's model as Gemini's env: its model and key when it's Gemini's.
export function model(m: Model | undefined, key?: string): Record<string, string> {
  if (!m || m.provider !== "openai" || new URL(m.base).hostname !== "generativelanguage.googleapis.com") return {};
  return { GEMINI_MODEL: m.model, ...(key && { GEMINI_API_KEY: key }) };
}

// A tool's name, from its title or its toolCallId, in Claude Code's.
export function names(servers: string[]): (tool: string, id?: string) => string {
  // Longest first, so corkboard-memory_x isn't corkboard's memory-x.
  const known = [...servers].sort((a, b) => b.length - a.length);
  const mcp = (server: string, tool: string) => (server === "corkboard-ui" && tool === "ask" ? "AskUserQuestion" : `mcp__${server}__${tool}`);
  const call = /^([A-Za-z0-9_.-]+?)__\1_\d+_\d+$/;
  return (raw, id) => {
    // A built-in's title is what it does: its name is in the id.
    if (id && call.test(id) && !call.test(raw) && !/ MCP Server\)$/.test(raw)) raw = id;
    const titled = /^(\S+) \((.+) MCP Server\)$/.exec(raw);
    if (titled) return mcp(titled[2], titled[1]);
    // A toolCallId's name, or a bare mcp_<server>_<tool>.
    const name = /^([A-Za-z0-9_.-]+?)__\1_\d+_\d+$/.exec(raw)?.[1] ?? raw;
    if (name.startsWith("mcp_")) {
      const s = known.find((s) => name.startsWith(`mcp_${s}_`));
      if (s) return mcp(s, name.slice(`mcp_${s}_`.length));
    }
    return name;
  };
}

export type GeminiOptions = {
  // corkboard's system prompt, written to <dir>/<name>/GEMINI.md.
  prompt?: string;
  dir: string;
  name: string;
  // Claude Code --mcp-config values, and ACP-shaped servers (corkboard-ui).
  mcp?: ClaudeMcp[];
  servers?: McpServer[];
  model?: Model;
  key?: string;
};

export function gemini(o: GeminiOptions): Spec {
  const mcp: Record<string, Entry> = {};
  for (const v of o.mcp ?? []) Object.assign(mcp, readMcp(v));
  for (const s of o.servers ?? []) {
    const [name, e] = fromAcp(s);
    mcp[name] = e;
  }
  const own = join(o.dir, o.name);
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const settings: Record<string, any> = { mcpServers: Object.fromEntries(Object.entries(mcp).map(([k, e]) => [k, entry(e)])) };
  if (o.prompt) {
    const file = join(own, "GEMINI.md");
    writeFileSync(file, o.prompt, { mode: 0o600 });
    settings.context = { includeDirectories: [own], loadMemoryFromIncludeDirectories: true };
  }
  const env: Record<string, string> = { ...model(o.model, o.key), GEMINI_CLI_TRUST_WORKSPACE: "true" };
  if (env.GEMINI_API_KEY) settings.security = { auth: { selectedType: "gemini-api-key" } };
  const path = join(own, "settings.json");
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = path;
  return { command: ["gemini", "--acp"], env, mcpServers: [], names: names(Object.keys(mcp)), files: [own] };
}
