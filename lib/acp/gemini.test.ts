// gemini()'s Spec (lib/acp/gemini.ts says what was verified): the settings
// file Gemini CLI reads at GEMINI_CLI_SYSTEM_DEFAULTS_PATH, the prompt beside
// it, a brain's model, and tool names in Claude Code's.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, model, names } from "./gemini";

const dir = mkdtempSync(join(tmpdir(), "acp-gemini-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const settings = (env: Record<string, string> | undefined) => JSON.parse(readFileSync(env!.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, "utf8"));

describe("gemini", () => {
  test("its settings: corkboard's servers, trusted, and the prompt in a directory of its own", () => {
    const spec = gemini({
      dir,
      name: "s1",
      prompt: "You are running inside corkboard.",
      mcp: [JSON.stringify({ mcpServers: { corkboard: { command: "corkboard-mcp", args: ["board"], env: { A: "1" } }, web: { type: "http", url: "https://x/mcp", headers: { Authorization: "t" } } } })],
      servers: [{ name: "corkboard-ui", command: "nvim", args: ["-l", "ui-mcp.lua"], env: [{ name: "NVIM", value: "/s" }] }],
    });
    expect(spec.command).toEqual(["gemini", "--acp"]);
    expect(spec.mcpServers).toEqual([]);
    expect(spec.env!.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
    const s = settings(spec.env);
    expect(s.mcpServers).toEqual({
      corkboard: { command: "corkboard-mcp", args: ["board"], env: { A: "1" }, trust: true },
      web: { httpUrl: "https://x/mcp", headers: { Authorization: "t" }, trust: true },
      "corkboard-ui": { command: "nvim", args: ["-l", "ui-mcp.lua"], env: { NVIM: "/s" }, trust: true },
    });
    expect(s.context).toEqual({ includeDirectories: [join(dir, "s1")], loadMemoryFromIncludeDirectories: true });
    expect(readFileSync(join(dir, "s1", "GEMINI.md"), "utf8")).toBe("You are running inside corkboard.");
    expect(spec.files).toEqual([join(dir, "s1")]);
    // The user's own login, with no key.
    expect(s.security).toBeUndefined();
    expect(spec.env!.GEMINI_API_KEY).toBeUndefined();
  });

  test("no prompt, no context", () => {
    const spec = gemini({ dir, name: "s2" });
    expect(settings(spec.env).context).toBeUndefined();
    expect(spec.files).toEqual([join(dir, "s2")]);
  });

  test("a Gemini brain's model and key, with the auth type session/load needs", () => {
    const spec = gemini({ dir, name: "s3", model: { provider: "openai", model: "gemini-2.5-pro", base: "https://generativelanguage.googleapis.com/v1beta/openai" }, key: "AIza-k" });
    expect(spec.env).toMatchObject({ GEMINI_MODEL: "gemini-2.5-pro", GEMINI_API_KEY: "AIza-k" });
    expect(settings(spec.env).security).toEqual({ auth: { selectedType: "gemini-api-key" } });
  });
});

describe("model", () => {
  test("only Gemini's own", () => {
    expect(model(undefined)).toEqual({});
    expect(model({ provider: "claude", model: "claude-opus-5-5" }, "sk-ant-api-x")).toEqual({});
    expect(model({ provider: "openai", model: "x/y", base: "https://openrouter.ai/api/v1" }, "k")).toEqual({});
    expect(model({ provider: "openai", model: "gemini-3.5-flash", base: "https://generativelanguage.googleapis.com/v1beta/openai" })).toEqual({ GEMINI_MODEL: "gemini-3.5-flash" });
  });
});

describe("names", () => {
  const name = names(["corkboard", "corkboard-memory", "corkboard-ui"]);
  test("an MCP tool's title", () => {
    expect(name("note_read (corkboard-memory MCP Server)")).toBe("mcp__corkboard-memory__note_read");
    expect(name("ask (corkboard-ui MCP Server)")).toBe("AskUserQuestion");
  });
  test("a toolCallId, built in or MCP", () => {
    expect(name("run_shell_command__run_shell_command_1794514186438_0")).toBe("run_shell_command");
    expect(name("mcp_corkboard-memory_note_read__mcp_corkboard-memory_note_read_1794514159593_0")).toBe("mcp__corkboard-memory__note_read");
    expect(name("mcp_corkboard_log")).toBe("mcp__corkboard__log");
  });
  test("a built-in's title is itself", () => {
    expect(name("echo hi")).toBe("echo hi");
  });
  test("a built-in by its toolCallId, an MCP tool by its title", () => {
    expect(name("echo hi", "run_shell_command__run_shell_command_1794514186438_0")).toBe("run_shell_command");
    expect(name("ask (corkboard-ui MCP Server)", "mcp_corkboard-ui_ask__mcp_corkboard-ui_ask_1794514159593_0")).toBe("AskUserQuestion");
    expect(name("echo hi", "t1")).toBe("echo hi");
  });
});
