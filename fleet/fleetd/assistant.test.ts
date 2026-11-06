// What a phone message runs as in an assistant's session, and when it has.

import { expect, test } from "bun:test";
import { command, ran } from "./assistant";

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
