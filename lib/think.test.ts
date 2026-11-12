// think() against a stand-in for each way it thinks: an OpenAI-compatible
// endpoint served here, and a `claude` on PATH that answers as `claude -p`
// does and writes down how it was run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, parseModel, sessionEnv, think, type Schema } from "./think";

const SCHEMA: Schema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] };

describe("parseModel", () => {
  test.each([
    ["", { provider: "claude" }],
    ["sonnet", { provider: "claude", model: "sonnet" }],
    ["claude:opus", { provider: "claude", model: "opus" }],
    ["openai:gpt-5.1", { provider: "openai", model: "gpt-5.1", base: "https://api.openai.com/v1" }],
    ["openrouter:anthropic/claude-sonnet-4.5", { provider: "openai", model: "anthropic/claude-sonnet-4.5", base: "https://openrouter.ai/api/v1" }],
    ["ollama:llama3.3", { provider: "openai", model: "llama3.3", base: "http://localhost:11434/v1" }],
    ["openai:qwen3@http://box:8000/v1/", { provider: "openai", model: "qwen3", base: "http://box:8000/v1" }],
  ])("%p", (s, want) => {
    expect(parseModel(s)).toEqual(want as any);
  });

  test.each(["gemini:pro", "openai:", "openai:x@ftp://y"])("%p is refused", (s) => {
    expect(() => parseModel(s)).toThrow();
  });
});

describe("check", () => {
  test("fits", () => expect(check({ items: ["a"] }, SCHEMA)).toBeNull());
  test("missing", () => expect(check({}, SCHEMA)).toBe("$.items is missing"));
  test("wrong type inside", () => expect(check({ items: ["a", 2] }, SCHEMA)).toBe("$.items[1] is number, not string"));
  test("null allowed", () => expect(check(null, { type: ["string", "null"] })).toBeNull());
  test("enum", () => expect(check("c", { enum: ["a", "b"] })).toContain("isn't one of"));
});

describe("an endpoint", () => {
  let server: ReturnType<typeof Bun.serve>;
  const asked: any[] = [];
  let answers: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        asked.push({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname, body: await req.json() });
        return Response.json({ choices: [{ message: { content: answers.shift() ?? "" } }] });
      },
    });
  });
  afterAll(() => server.stop(true));
  const model = () => parseModel(`openai:test-model@http://localhost:${server.port}/v1`);

  test("text, with the brain's key", async () => {
    answers = ["hello"];
    expect(await think({ system: "be brief", input: "hi", model: model(), key: "sk-test" })).toEqual({ text: "hello" });
    const a = asked.at(-1);
    expect(a.path).toBe("/v1/chat/completions");
    expect(a.auth).toBe("Bearer sk-test");
    expect(a.body.model).toBe("test-model");
    expect(a.body.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
  });

  test("JSON in a fence, checked", async () => {
    answers = ['Here:\n```json\n{"items":["a","b"]}\n```'];
    const t = await think({ system: "s", input: "i", schema: SCHEMA, model: model() });
    expect(t.json).toEqual({ items: ["a", "b"] });
    expect(asked.at(-1).body.response_format.json_schema.schema).toEqual(SCHEMA);
  });

  test("asked again once when it doesn't fit", async () => {
    answers = ['{"things":[]}', '{"items":["x"]}'];
    const n = asked.length;
    expect((await think({ system: "s", input: "i", schema: SCHEMA, model: model() })).json).toEqual({ items: ["x"] });
    expect(asked.length - n).toBe(2);
    expect(asked.at(-1).body.messages[0].content).toContain("$.items is missing");
  });

  test("and gives up after that", async () => {
    answers = ["nope", "still nope"];
    await expect(think({ system: "s", input: "i", schema: SCHEMA, model: model() })).rejects.toThrow("doesn't fit its schema");
  });
});

describe("claude", () => {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-think-test-"));
  const log = join(dir, "log");
  const path = process.env.PATH;

  beforeAll(() => {
    // Answers with structured_output when given a schema, as claude -p does.
    writeFileSync(
      join(dir, "claude"),
      `#!/usr/bin/env bash
cat > "${log}.input"
printf '%s\n' "$@" > "${log}.args"
printf '%s\n' "\${CLAUDE_CODE_OAUTH_TOKEN:-}" "\${ANTHROPIC_API_KEY:-}" "\${CORKBOARD_NO_MEMORY:-}" > "${log}.env"
if [[ " $* " == *" --json-schema "* ]]; then echo '{"structured_output":{"items":["s"]}}'; else echo '{"result":"thought"}'; fi
`,
    );
    chmodSync(join(dir, "claude"), 0o755);
    process.env.PATH = `${dir}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  const ran = () => {
    const [oauth, key, nomem] = readFileSync(`${log}.env`, "utf8").split("\n");
    return { args: readFileSync(`${log}.args`, "utf8").split("\n").slice(0, -1), input: readFileSync(`${log}.input`, "utf8"), oauth, key, nomem };
  };

  test("text, on the machine's login", async () => {
    expect(await think({ system: "s", input: "the input" })).toEqual({ text: "thought" });
    const r = ran();
    expect(r.input).toBe("the input");
    expect(r.args).toContain("--system-prompt-file");
    expect(r.args).not.toContain("--model");
    expect(r.oauth).toBe("");
    expect(r.nomem).toBe("1");
  });

  test("a model, a schema and a setup-token", async () => {
    const t = await think({ system: "s", input: "i", schema: SCHEMA, model: parseModel("claude:haiku"), key: "sk-ant-oat01-x" });
    expect(t.json).toEqual({ items: ["s"] });
    const r = ran();
    expect(r.args.slice(r.args.indexOf("--model"), r.args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(r.oauth).toBe("sk-ant-oat01-x");
  });

  test("an API key", async () => {
    await think({ system: "s", input: "i", key: "sk-ant-api03-y" });
    expect(ran().key).toBe("sk-ant-api03-y");
  });
});

describe("sessionEnv", () => {
  test("claude: its model, and the brain's key as what it is", () => {
    expect(sessionEnv(parseModel(""))).toEqual({});
    expect(sessionEnv(parseModel("opus"), "sk-ant-oat01-x")).toEqual({ ANTHROPIC_MODEL: "opus", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
    expect(sessionEnv(parseModel("claude:"), "sk-ant-api03-y")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-y" });
  });

  test("an endpoint: its Anthropic side, every model its one, and no account of the machine's", () => {
    const env = sessionEnv(parseModel("openrouter:moonshotai/kimi-k2"), "sk-or-z");
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-z",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_MODEL: "moonshotai/kimi-k2",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "moonshotai/kimi-k2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "moonshotai/kimi-k2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "moonshotai/kimi-k2",
      CLAUDE_CODE_SUBAGENT_MODEL: "moonshotai/kimi-k2",
    });
    expect(sessionEnv(parseModel("ollama:qwen3")).ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(sessionEnv(parseModel("ollama:qwen3")).ANTHROPIC_AUTH_TOKEN).toBe("corkboard");
    expect(sessionEnv(parseModel("openai:qwen3@http://box:8000/v1/")).ANTHROPIC_BASE_URL).toBe("http://box:8000");
  });

  test("OpenAI's own is refused", () => {
    expect(() => sessionEnv(parseModel("openai:gpt-5.1"), "sk-x")).toThrow(/Anthropic-compatible/);
  });
});
