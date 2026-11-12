// Codex as an ACP agent (`codex-acp`, the agentclientprotocol adapter,
// verified against 2.1.1 with Codex 0.167.0, nixpkgs'; nixpkgs wraps it
// with CODEX_PATH set to its own codex). Everything goes in the adapter's
// environment, so the user's ~/.codex (their `codex login`, config.toml)
// is left as it is:
//
// - CODEX_CONFIG, JSON merged into each thread's config: corkboard's
//   prompt as `developer_instructions`, a developer message beside Codex's
//   own instructions rather than in their place; the MCP servers as
//   `mcp_servers`, each with `default_tools_approval_mode = "approve"` so
//   corkboard's own tools don't ask leave first; and the brain's `model`.
//   Handed over in session/new instead, an MCP call asks permission every
//   time, corkboard-ui's ask included.
// - INITIAL_AGENT_MODE=workspace-write: edits in the workspace go ahead,
//   anything else (the network, outside it) is a session/request_permission
//   for corkboard to answer. Codex's own default, "agent", has a second
//   model call ("Guardian Review", drawn as a tool call of its own) approve
//   each action instead of asking.
// - A brain's model, which must be behind the Responses API (Codex 0.167
//   dropped `wire_api = "chat"`): OpenAI, OpenRouter, or a gateway such as
//   LiteLLM or Ollama. It goes through the adapter's "gateway" auth as
//   DEFAULT_AUTH_REQUEST, the key a header the adapter keeps in memory; the
//   "api-key" method would log in to Codex and write the key to
//   ~/.codex/auth.json, over the user's ChatGPT login. A Claude brain's
//   model Codex can't run: Codex's own login and model, as with no brain.
// - With no gateway, a session/new before any login is "Authentication
//   required": `codex login` once, as the user would for Codex itself.
//   NO_BROWSER keeps the adapter from offering a browser login.
//
// Tool calls are titled mcp.<server>.<tool> for an MCP tool (rawInput
// { server, tool, arguments }), else what the tool does; names() gives an MCP
// tool's back in Claude Code's mcp__<server>__<tool>, and corkboard-ui's ask as
// AskUserQuestion. session/load replays the history before it answers, as
// opencode's does. A model Codex has no metadata for (any but OpenAI's) has
// each turn start with a warning of it as a message chunk of its own, which
// is left out.

import type { McpServer, Spec } from "./client";
import { fromAcp, readMcp, type ClaudeMcp } from "./opencode";
import type { Model } from "../think";

type Entry = ReturnType<typeof readMcp>[string];

// Codex's mcp_servers entry for one.
function entry(e: Entry): object {
  const approve = { default_tools_approval_mode: "approve" };
  if (e.type === "http" || e.type === "sse" || (!e.command && e.url)) return { url: e.url, http_headers: e.headers ?? {}, ...approve };
  return { command: e.command, args: e.args ?? [], env: e.env ?? {}, ...approve };
}

// The brain's model as the thread's `model` and the gateway it's reached
// through; nothing for a model Codex can't run.
export function model(m: Model | undefined, key?: string): { config: object; env: Record<string, string> } {
  if (!m || m.provider !== "openai") return { config: {}, env: {} };
  const gateway = { baseUrl: m.base, headers: key ? { Authorization: `Bearer ${key}` } : {}, providerName: "corkboard" };
  return { config: { model: m.model }, env: { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "gateway", _meta: { gateway } }) } };
}

export type CodexOptions = {
  // corkboard's system prompt.
  prompt?: string;
  // Claude Code --mcp-config values, and ACP-shaped servers (corkboard-ui).
  mcp?: ClaudeMcp[];
  servers?: McpServer[];
  model?: Model;
  key?: string;
};

export function codex(o: CodexOptions): Spec {
  const mcp: Record<string, Entry> = {};
  for (const v of o.mcp ?? []) Object.assign(mcp, readMcp(v));
  for (const s of o.servers ?? []) {
    const [name, e] = fromAcp(s);
    mcp[name] = e;
  }
  const config: Record<string, unknown> = { mcp_servers: Object.fromEntries(Object.entries(mcp).map(([k, e]) => [k, entry(e)])) };
  if (o.prompt) config.developer_instructions = o.prompt;
  const m = model(o.model, o.key);
  Object.assign(config, m.config);
  const names = (tool: string) => {
    const call = /^mcp\.(.+)\.([^.]+)$/.exec(tool);
    if (!call) return tool;
    if (call[1] === "corkboard-ui" && call[2] === "ask") return "AskUserQuestion";
    return `mcp__${call[1]}__${call[2]}`;
  };
  return {
    command: ["codex-acp"],
    env: { ...m.env, CODEX_CONFIG: JSON.stringify(config), INITIAL_AGENT_MODE: "workspace-write", NO_BROWSER: "1" },
    mcpServers: [],
    names,
    quiet: (u) => u.sessionUpdate === "agent_message_chunk" && /^Warning: Model metadata for `[^`]*` not found\./.test(String(u.content?.text ?? "")),
  };
}
