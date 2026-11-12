// One-shot thinking: a system prompt and an input to an answer, by whichever
// model a brain names (.agent/plans/agents.md's `think`). No tools, no
// session, no SDK: Claude Code's CLI on the machine's login (or the brain's
// token), or any OpenAI-compatible /chat/completions with the brain's key.
//
// A model is written <provider>:<model>[@<base url>]:
//   claude:sonnet, or sonnet         `claude -p --model sonnet`
//   openai:gpt-5.1                   api.openai.com
//   openai:qwen3@http://box:8000/v1  any OpenAI-compatible endpoint
//   openrouter:anthropic/claude-sonnet-4.5, ollama:llama3.3  the same, at theirs
// With a schema the answer is JSON, checked against it, asked again once if
// it doesn't fit.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Model = { provider: "claude"; model?: string } | { provider: "openai"; model: string; base: string };

// A JSON schema, as much of one as check() reads.
export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
};

export type ThinkOptions = {
  system: string;
  input: string;
  schema?: Schema;
  // The brain's model (parseModel's), Claude Code's default without it.
  model?: Model;
  // The brain's key: for an endpoint, its bearer token; for claude, a
  // setup-token (sk-ant-oat…) or an API key, else the machine's login.
  key?: string;
  timeout?: number;
};

export type Thought = { text: string; json?: unknown };

const BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

const TIMEOUT = 10 * 60_000;

// What a brain's model says, or why it can't be read. Empty: Claude Code's
// default.
export function parseModel(s: string | null | undefined): Model {
  const v = (s ?? "").trim();
  if (!v) return { provider: "claude" };
  const colon = v.indexOf(":");
  // A bare name, or a URL's scheme, isn't a provider.
  if (colon < 0 || v.slice(colon + 1).startsWith("//")) return { provider: "claude", model: v };
  const provider = v.slice(0, colon);
  const rest = v.slice(colon + 1);
  if (provider === "claude") return rest ? { provider: "claude", model: rest } : { provider: "claude" };
  if (!(provider in BASES)) throw new Error(`no provider ${provider}: claude, ${Object.keys(BASES).join(", ")}`);
  const at = rest.lastIndexOf("@");
  const model = at < 0 ? rest : rest.slice(0, at);
  const base = at < 0 ? BASES[provider] : rest.slice(at + 1);
  if (!model) throw new Error(`${v} names no model`);
  if (!/^https?:\/\/[^/]/.test(base)) throw new Error(`${base} isn't an http(s) URL`);
  return { provider: "openai", model, base: base.replace(/\/+$/, "") };
}

// Where value doesn't fit schema, as a path and what's wrong; null where it does.
export function check(value: unknown, schema: Schema, path = "$"): string | null {
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${path} isn't one of ${JSON.stringify(schema.enum)}`;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const is = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const fits = types.some((t) => t === is || (t === "integer" && is === "number" && Number.isInteger(value)) || (t === "number" && is === "number"));
    if (!fits) return `${path} is ${is}, not ${types.join(" or ")}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const bad = check(value[i], schema.items, `${path}[${i}]`);
      if (bad) return bad;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) return `${path}.${k} is missing`;
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (!(k in o)) continue;
      const bad = check(o[k], s, `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

// The JSON in a model's text: all of it, or a fenced block, or the outermost braces.
function json(text: string): unknown {
  const t = text.trim();
  for (const s of [t, t.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    if (!s) continue;
    try {
      return JSON.parse(s);
    } catch {}
  }
  throw new Error(`the answer isn't JSON: ${t.slice(0, 200)}`);
}

export async function think(o: ThinkOptions): Promise<Thought> {
  const model = o.model ?? { provider: "claude" };
  const ask = model.provider === "claude" ? (system: string) => claude(o, model, system) : (system: string) => endpoint(o, model, system);
  let system = o.system;
  for (let attempt = 0; ; attempt++) {
    const got = await ask(system);
    if (!o.schema) return { text: got.text };
    let bad: string | null;
    let value: unknown;
    try {
      value = got.json !== undefined ? got.json : json(got.text);
      bad = check(value, o.schema);
    } catch (e) {
      bad = (e as Error).message;
    }
    if (!bad) return { text: got.text, json: value };
    if (attempt > 0) throw new Error(`the answer doesn't fit its schema: ${bad}`);
    system = `${o.system}\n\nYour last answer didn't fit the schema (${bad}). Answer with only JSON that fits it.`;
  }
}

// The schema in words, for a model that isn't given it any other way.
const asked = (system: string, schema?: Schema) => (schema ? `${system}\n\nAnswer with only JSON that fits this schema:\n${JSON.stringify(schema)}` : system);

// `claude -p` with no tools, MCP servers or settings, in an empty directory,
// the input on stdin; CORKBOARD_NO_MEMORY keeps its own hooks from sending
// it back as an episode.
function claude(o: ThinkOptions, model: { model?: string }, system: string): Promise<Thought> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-think-"));
  const file = join(dir, "system.md");
  writeFileSync(file, system, { mode: 0o600 });
  const args = ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", file, "--output-format", "json"];
  if (model.model) args.push("--model", model.model);
  if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
  const env: Record<string, string | undefined> = { ...process.env, CORKBOARD_NO_MEMORY: "1" };
  if (o.key) env[o.key.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = o.key;
  return new Promise<Thought>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), o.timeout ?? TIMEOUT);
    child.on("error", (e) => reject(new Error(`claude: ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { result?: unknown; structured_output?: unknown; is_error?: boolean; subtype?: string };
        if (j.is_error) throw new Error(String(j.result ?? j.subtype ?? "an error"));
        if (o.schema && j.structured_output !== undefined) return resolve({ text: JSON.stringify(j.structured_output), json: j.structured_output });
        if (typeof j.result !== "string") throw new Error("no result");
        resolve({ text: j.result });
      } catch (e) {
        reject(new Error(`claude -p${code ? ` exited ${code}` : ""}: ${(err.trim().split("\n").pop() || (e as Error).message).slice(0, 500)}`));
      }
    });
    child.stdin.end(o.input);
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// An OpenAI-compatible endpoint's chat completion, the schema as its
// response_format and in the prompt both, since not every one honours the first.
async function endpoint(o: ThinkOptions, model: { model: string; base: string }, system: string): Promise<Thought> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: [
      { role: "system", content: asked(system, o.schema) },
      { role: "user", content: o.input },
    ],
  };
  if (o.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: o.schema } };
  const res = await fetch(`${model.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(o.key && { Authorization: `Bearer ${o.key}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeout ?? TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${model.base}: ${res.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${model.base}: no answer`);
  return { text: content };
}

// What Claude Code needs in its environment to run a whole session on a
// brain's model (.agent/plans/agents.md stage 3): for claude, the model and
// the brain's key, if it has one; for an endpoint, its Anthropic-compatible
// side, which OpenRouter, Ollama, LiteLLM and vLLM serve beside their
// OpenAI one, at the same base without its /v1. Every model Claude Code
// would pick (its subagents', its background calls') is that one. OpenAI's
// own has no such side.
export function sessionEnv(model: Model, key?: string): Record<string, string> {
  if (model.provider === "claude") {
    const env: Record<string, string> = model.model ? { ANTHROPIC_MODEL: model.model } : {};
    if (key) env[key.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = key;
    return env;
  }
  if (new URL(model.base).hostname === "api.openai.com") throw new Error("Claude Code can't run on OpenAI's API, which has no Anthropic-compatible side");
  return {
    ANTHROPIC_BASE_URL: model.base.replace(/\/v1$/, ""),
    // Ollama takes any token; the others, the brain's key.
    ANTHROPIC_AUTH_TOKEN: key || "corkboard",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_MODEL: model.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
    CLAUDE_CODE_SUBAGENT_MODEL: model.model,
  };
}
