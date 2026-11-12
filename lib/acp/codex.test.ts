// The Spec lib/acp/codex.ts builds for codex-acp (what it says was verified).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "./codex";
import { Transcript } from "./transcript";

describe("codex", () => {
  test("corkboard's servers approved in its config, the prompt as developer instructions, and their tools' names", () => {
    const s = codex({
      prompt: "Be brief.",
      mcp: [JSON.stringify({ mcpServers: { corkboard: { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } }, "corkboard-memory": { command: "bun", args: ["m.ts"] } } })],
      servers: [{ name: "corkboard-ui", command: "nvim", args: ["-l", "ui.lua"], env: [{ name: "CORKBOARD_BUF", value: "3" }] }],
    });
    expect(s.command).toEqual(["codex-acp"]);
    const config = JSON.parse(s.env!.CODEX_CONFIG);
    expect(config.mcp_servers).toEqual({
      corkboard: { url: "http://x/mcp", http_headers: { Authorization: "Bearer t" }, default_tools_approval_mode: "approve" },
      "corkboard-memory": { command: "bun", args: ["m.ts"], env: {}, default_tools_approval_mode: "approve" },
      "corkboard-ui": { command: "nvim", args: ["-l", "ui.lua"], env: { CORKBOARD_BUF: "3" }, default_tools_approval_mode: "approve" },
    });
    expect(config.developer_instructions).toBe("Be brief.");
    expect(s.env!.INITIAL_AGENT_MODE).toBe("workspace-write");
    expect(s.mcpServers).toEqual([]);
    expect(s.names!("mcp.corkboard-memory.memory_recall")).toBe("mcp__corkboard-memory__memory_recall");
    expect(s.names!("mcp.corkboard.claim_card")).toBe("mcp__corkboard__claim_card");
    expect(s.names!("mcp.corkboard-ui.say")).toBe("mcp__corkboard-ui__say");
    expect(s.names!("mcp.corkboard-ui.ask")).toBe("AskUserQuestion");
    expect(s.names!("Run git status")).toBe("Run git status");
  });

  test("a brain's model through the gateway, its key a header", () => {
    const s = codex({ model: { provider: "openai", model: "openai/gpt-6.1-sol", base: "https://openrouter.ai/api/v1" }, key: "sk-or-1" });
    expect(JSON.parse(s.env!.CODEX_CONFIG).model).toBe("openai/gpt-6.1-sol");
    expect(JSON.parse(s.env!.DEFAULT_AUTH_REQUEST)).toEqual({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://openrouter.ai/api/v1", headers: { Authorization: "Bearer sk-or-1" }, providerName: "corkboard" } },
    });
    expect(s.env!.OPENAI_API_KEY).toBeUndefined();
  });

  test("no brain, or a Claude one: Codex's own login and model", () => {
    for (const s of [codex({}), codex({ model: { provider: "claude", model: "claude-opus-5-5" }, key: "sk-ant-api-1" })]) {
      expect(s.env!.DEFAULT_AUTH_REQUEST).toBeUndefined();
      expect(JSON.parse(s.env!.CODEX_CONFIG).model).toBeUndefined();
    }
  });
});

describe("its transcript", () => {
  test("an MCP call's arguments as its input, and its result's content", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-codex-"));
    try {
      const t = new Transcript(dir, "s", codex({}).names);
      const questions = [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }];
      t.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "mcp.corkboard-ui.ask", status: "in_progress", rawInput: { server: "corkboard-ui", tool: "ask", arguments: { questions } } });
      t.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { result: { content: [{ type: "text", text: "Which? → A" }] }, error: null } });
      const records = readFileSync(t.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(records.map((r) => r.message.content[0])).toMatchObject([
        { type: "tool_use", name: "AskUserQuestion", input: { questions } },
        { type: "tool_result", content: "Which? → A", is_error: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("its warning of a model it has no metadata for isn't the conversation", () => {
    const { quiet } = codex({});
    const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    expect(quiet!(chunk("Warning: Model metadata for `qwen3:1.7b` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n"))).toBe(true);
    expect(quiet!(chunk("Warning: the tests fail."))).toBe(false);
  });

  // As codex-acp 2.1.1 sends an exec_command (seen live).
  test("a command's output from its terminal deltas, and a failing exit as an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-codex-"));
    try {
      const t = new Transcript(dir, "s", codex({}).names);
      const run = (id: string, data: string[], exit: number) => {
        t.update({ sessionUpdate: "tool_call", toolCallId: id, name: "exec_command", kind: "execute", title: "echo", status: "in_progress", rawInput: { command: "echo", cwd: "/w" }, content: [{ type: "terminal", terminalId: id }] });
        for (const d of data) t.update({ sessionUpdate: "tool_call_update", toolCallId: id, _meta: { terminal_output_delta: { data: d, terminal_id: id } } });
        t.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", _meta: { terminal_exit: { exit_code: exit, signal: null, terminal_id: id } } });
      };
      run("c1", ["corkboard", "-ok\n"], 0);
      run("c2", ["no such file\n"], 1);
      const results = readFileSync(t.path, "utf8").trim().split("\n").map((l) => JSON.parse(l).message.content[0]).filter((c) => c.type === "tool_result");
      expect(results).toMatchObject([
        { tool_use_id: "c1", content: "corkboard-ok", is_error: false },
        { tool_use_id: "c2", content: "no such file", is_error: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A command Codex parses as a list, read or search (seen live with ls).
  test("a listing's title as its description, having no input", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-codex-"));
    try {
      const t = new Transcript(dir, "s", codex({}).names);
      t.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "exec_command", kind: "read", title: "List files", status: "in_progress" });
      t.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
      const use = readFileSync(t.path, "utf8").trim().split("\n").map((l) => JSON.parse(l).message.content[0]).find((c) => c.type === "tool_use");
      expect(use).toMatchObject({ name: "exec_command", input: { description: "List files" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
