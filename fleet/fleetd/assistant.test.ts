// What a phone message runs as in an assistant's session, and when it has.

import { describe, expect, test } from "bun:test";
import { command, exports, ran } from "./assistant";

test("a slash command runs as one, and bare /mcp reconnects every server", () => {
  expect(command("/mcp")).toBe("/mcp reconnect all");
  expect(command(" /mcp reconnect corkboard-memory ")).toBe("/mcp reconnect corkboard-memory");
  expect(command("/compact")).toBe("/compact");
  expect(command("/plugin:skill do it")).toBe("/plugin:skill do it");
});

test("anything else is a message", () => {
  expect(command("what's on today?")).toBeUndefined();
  expect(command("/ not a command")).toBeUndefined();
  expect(command("/usr/bin is a path")).toBeUndefined();
  expect(command("try /mcp")).toBeUndefined();
});

test("a command has run once its result is under it", () => {
  const screen = ["❯ [phone] hey pepper", "● Hey Matt.", "", "❯ /mcp reconnect all"];
  expect(ran(screen, "/mcp reconnect all")).toBe(false);
  expect(ran([...screen, "  ⎿  Reconnected 1 of 1 MCP server", "", "───", "❯ "], "/mcp reconnect all")).toBe(true);
  // An earlier run's result isn't this one's.
  expect(ran(["❯ /mcp reconnect all", "  ⎿  Reconnected", "❯ /mcp reconnect all"], "/mcp reconnect all")).toBe(false);
});

describe("exports", () => {
  test("what sh sources gives back the env, quotes and all", async () => {
    const env = { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "it's $HOME `x`", "bad name": "no" };
    const text = exports(env);
    expect(text).not.toContain("bad name");
    const out = Bun.spawnSync(["sh", "-c", `${text}printf '%s|%s|%s' "$ANTHROPIC_BASE_URL" "\${ANTHROPIC_API_KEY-unset}" "$ANTHROPIC_AUTH_TOKEN"`]).stdout.toString();
    expect(out).toBe("https://openrouter.ai/api||it's $HOME `x`");
  });
});
