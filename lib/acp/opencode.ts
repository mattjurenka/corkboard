// opencode as an ACP agent (`opencode acp`, verified against 2.2.5, nixpkgs'):
// corkboard's system prompt, MCP servers and the brain's model go in
// OPENCODE_CONFIG_CONTENT, which opencode merges over the user's own config.
//
// - The prompt is a file in `instructions`.
// - The MCP servers are opencode's own `mcp` entries with codemode off,
//   not session/new's: handed over that way, opencode puts every MCP tool
//   behind one `execute` that runs code calling them, and a call's name and
//   input only show in its result. Its own are called <server>_<tool>,
//   which names() gives back in Claude Code's mcp__<server>__<tool> (and
//   corkboard-ui's ask as AskUserQuestion), so the transcript reads as
//   Claude Code's does. Its own `question` is off: ACP can't show it.
// - A brain's model: openrouter and openai by opencode's own providers, any
//   other OpenAI-compatible endpoint as a provider of corkboard's.
// - Permissions are the user's opencode config's: by default it asks
//   before nothing, so set `permission` there to be asked from corkboard.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer, Spec } from "./client";
import type { Model } from "../think";

// A Claude Code --mcp-config value: a file, or the JSON itself.
export type ClaudeMcp = string;

type Entry = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

// Claude Code's { mcpServers: { name: … } }, from a file or JSON.
export function readMcp(value: ClaudeMcp): Record<string, Entry> {
  const text = value.trim().startsWith("{") ? value : readFileSync(value, "utf8");
  const parsed = JSON.parse(text);
  return parsed && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
}

// opencode's entry for one.
function entry(e: Entry): object {
  if (e.type === "http" || e.type === "sse" || (!e.command && e.url)) return { type: "remote", url: e.url, headers: e.headers ?? {}, codemode: false };
  return { type: "local", command: [e.command!, ...(e.args ?? [])], environment: e.env ?? {}, codemode: false };
}

// ACP's stdio server (agent/init.lua's ui_server) as Claude Code's entry.
export function fromAcp(s: McpServer): [string, Entry] {
  if ("url" in s) return [s.name, { type: "http", url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) }];
  return [s.name, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((v) => [v.name, v.value])) }];
}

// The brain's model as opencode's config: its `model`, the provider it needs,
// and the key's variable.
export function model(m: Model | undefined, key?: string): { config: object; env: Record<string, string> } {
  if (!m) return { config: {}, env: {} };
  if (m.provider === "claude") {
    // An API key works; a setup-token is Claude Code's alone.
    const env: Record<string, string> = key?.startsWith("sk-ant-api") ? { ANTHROPIC_API_KEY: key } : {};
    return { config: m.model ? { model: `anthropic/${m.model}` } : {}, env };
  }
  if (m.base === "https://openrouter.ai/api/v1") return { config: { model: `openrouter/${m.model}` }, env: key ? { OPENROUTER_API_KEY: key } : {} };
  if (m.base === "https://api.openai.com/v1") return { config: { model: `openai/${m.model}` }, env: key ? { OPENAI_API_KEY: key } : {} };
  return {
    config: {
      model: `corkboard/${m.model}`,
      provider: { corkboard: { npm: "@ai-sdk/openai-compatible", name: "corkboard", options: { baseURL: m.base, ...(key && { apiKey: key }) }, models: { [m.model]: {} } } },
    },
    env: {},
  };
}

export type OpencodeOptions = {
  // corkboard's system prompt, written to <dir>/<name>.md for `instructions`.
  prompt?: string;
  dir: string;
  name: string;
  // Claude Code --mcp-config values, and ACP-shaped servers (corkboard-ui).
  mcp?: ClaudeMcp[];
  servers?: McpServer[];
  model?: Model;
  key?: string;
};

export function opencode(o: OpencodeOptions): Spec {
  const mcp: Record<string, Entry> = {};
  for (const v of o.mcp ?? []) Object.assign(mcp, readMcp(v));
  for (const s of o.servers ?? []) {
    const [name, e] = fromAcp(s);
    mcp[name] = e;
  }
  const files: string[] = [];
  // Its own question tool can't be shown to an ACP client, so a call to it
  // only ever fails; corkboard-ui's ask is the one that reaches the user.
  const config: Record<string, unknown> = { mcp: Object.fromEntries(Object.entries(mcp).map(([k, e]) => [k, entry(e)])), tools: { question: false } };
  if (o.prompt) {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const file = join(o.dir, `${o.name}.md`);
    writeFileSync(file, o.prompt, { mode: 0o600 });
    config.instructions = [file];
    files.push(file);
  }
  const m = model(o.model, o.key);
  Object.assign(config, m.config);
  // Longest first, so corkboard-memory_x isn't corkboard's memory-x.
  const servers = Object.keys(mcp).sort((a, b) => b.length - a.length);
  const names = (tool: string) => {
    if (tool === "corkboard-ui_ask") return "AskUserQuestion";
    const s = servers.find((s) => tool.startsWith(`${s}_`));
    return s ? `mcp__${s}__${tool.slice(s.length + 1)}` : tool;
  };
  // Its MCP tools join a session about 100ms after session/new says it's
  // open (2.2.5), so a first prompt sent at once goes without them.
  return { command: ["opencode", "acp"], env: { ...m.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, mcpServers: [], names, files, settle: Object.keys(mcp).length ? 1000 : 0 };
}
