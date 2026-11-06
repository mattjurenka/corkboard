// What a phone message runs as in an assistant's session.

import { expect, test } from "bun:test";
import { command } from "./assistant";

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
