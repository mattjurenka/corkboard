// What Claude Code's session logs say a session cost and what it went on
// (corkboard.usage.transcript), what each card's agents cost from them
// (corkboard.usage's card_costs), and the budget limits on that
// (corkboard.budget), on logs written as Claude Code writes them.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Card, parse } from "../mcp/cards";
import { sandbox } from "./testing";

const box = sandbox();
afterAll(() => box.cleanup());

// A log's records, as JSONL.
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r) + "\n").join("");
const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, s)).toISOString();
const assistant = (id: string, usage: object, content: object[], s: number, model = "claude-opus-5") => ({
  type: "assistant",
  timestamp: at(s),
  message: { id, model, usage, content },
});

// A session: a prompt, a reply that reads a file in two records (the same
// usage twice), the file, the answer; a cache miss after an idle hour; a
// compaction; and what it cost.
const SESSION = [
  { type: "user", timestamp: at(0), cwd: "/p", message: { role: "user", content: "Read the parser" } },
  assistant("m1", { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 100 }, [{ type: "text", text: "Reading it." }], 1),
  assistant("m1", { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 100 }, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/src/parser.ts" } }], 1),
  { type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(8000) }] } },
  assistant("m2", { input_tokens: 2, cache_creation_input_tokens: 2200, cache_read_input_tokens: 5010, output_tokens: 50 }, [{ type: "text", text: "It parses." }], 3),
  { type: "user", timestamp: at(3600 + 10), message: { role: "user", content: "And now?" } },
  assistant("m3", { input_tokens: 5, cache_creation_input_tokens: 7300, cache_read_input_tokens: 0, output_tokens: 20 }, [{ type: "text", text: "Now this." }], 3600 + 11),
  { type: "system", subtype: "compact_boundary", timestamp: at(3700) },
  { type: "user", isCompactSummary: true, timestamp: at(3701), message: { role: "user", content: "Summary of it all" } },
  assistant("m4", { input_tokens: 1, cache_creation_input_tokens: 400, cache_read_input_tokens: 3000, output_tokens: 10 }, [{ type: "text", text: "Done." }], 3702),
  { type: "ai-title", aiTitle: "Parser work" },
  { type: "cost-state", totalCostUSD: 1.25, modelUsage: { "claude-opus-5[1m]": { costUSD: 1.25 } } },
];

describe("a session's log", () => {
  const log = box.write(join(box.dir, "session.jsonl"), jsonl(SESSION));
  const got = box.lua(
    `local t = require("corkboard.usage.transcript")
    local log, grew = t.read(input, "/p")
    local again = select(2, t.read(input, "/p"))
    local s = t.summarize(log, t.prices({ log = log, agents = {} }))
    return { grew = grew, again = again, title = log.title, s = s }`,
    log,
  );

  test("counts each request once, however many records repeat its usage", () => {
    expect(got.grew).toBe(true);
    expect(got.again).toBe(false);
    expect(got.title).toBe("Parser work");
    expect(got.s.requests).toBe(4);
    expect(got.s.model).toBe("claude-opus-5");
    expect(got.s.tokens).toEqual({ input: 18, write: 14900, read: 8010, output: 180, thinking: 0, write_1h: 0 });
    expect(got.s.context).toBe(3401);
  });

  test("a cache miss after the cache expired, and none after a compaction", () => {
    expect(got.s.cache.misses).toHaveLength(1);
    expect(got.s.cache.misses[0]).toMatchObject({ request: 3, idle: 3608, idle_text: "60m", ttl: "5m" });
    expect(got.s.cache.misses[0].label).toBe("Miss at request 3 (idle 60m, cache expired)");
    expect(got.s.miss_points).toEqual([2]);
    expect(got.s.cache.hit).toBeCloseTo(8010 / (8010 + 14900 + 18), 6);
  });

  test("what the tokens went on: the file read, the tools' results by tool", () => {
    const kinds = Object.fromEntries(got.s.categories.map((c: any) => [c.kind, c]));
    expect(Object.keys(kinds).sort()).toEqual(["call:Read", "compact", "other", "rebuild", "system", "text", "tool:Read", "user"]);
    expect(kinds["tool:Read"].label).toBe("Read results");
    expect(kinds["call:Read"].label).toBe("Read calls");
    expect(kinds["call:Read"].output).toBe(true);
    // Of the 2202 tokens the next request says were new, the file (2000 by
    // its size, scaled up) has most; the reply that asked for it the rest.
    expect(kinds["tool:Read"].added).toBeGreaterThan(2000);
    expect(kinds["tool:Read"].added + kinds["call:Read"].added).toBeLessThanOrEqual(2202);
    const read = got.s.top.find((t: any) => t.kind === "Read results");
    expect(read.label).toBe("Read src/parser.ts");
    const shares = got.s.categories.reduce((n: number, c: any) => n + c.share, 0);
    expect(shares).toBeCloseTo(1, 6);
  });

  test("priced by the session's own cost", () => {
    expect(got.s.cost).toBeCloseTo(1.25, 6);
    const costs = got.s.categories.reduce((n: number, c: any) => n + c.cost, 0);
    expect(costs).toBeCloseTo(1.25, 6);
  });

  test("read again, only what was appended, and a half-written line waits", () => {
    const path = box.write(join(box.dir, "grow.jsonl"), jsonl(SESSION.slice(0, 3)));
    const more = jsonl(SESSION.slice(3, 5));
    const got = box.lua(
      `local t = require("corkboard.usage.transcript")
      local log = t.read(input.path, "/p")
      local one = log.n
      local f = io.open(input.path, "a") f:write(input.half) f:close()
      local _, grew = t.read(input.path, "/p")
      local half = log.n
      f = io.open(input.path, "a") f:write(input.rest) f:close()
      t.read(input.path, "/p")
      return { one, grew, half, log.n }`,
      { path, half: more.slice(0, 50), rest: more.slice(50) },
    );
    expect(got).toEqual([1, true, 1, 2]);
  });
});

describe("card costs and the budget", () => {
  const tasks = () => join(box.board, "tasks");
  const card = (id: string): Card => parse(join(tasks(), readdirSync(tasks()).find((n) => n.startsWith(`${id.toLowerCase()} - `))!))!;
  const transcript = (name: string, cost: number) => {
    const p = box.write(join(box.dir, `${name}.jsonl`), jsonl(SESSION.slice(0, -1)));
    appendFileSync(p, JSON.stringify({ type: "cost-state", totalCostUSD: cost, modelUsage: {} }) + "\n");
    return p;
  };

  beforeEach(() => {
    box.lua(`
      local cards = require("corkboard.cards")
      pcall(vim.fn.delete, cards.dir(), "rf")
      cards.create("Cheap", "doing", "")
      cards.create("Dear", "doing", "")
      cards.create("Done", "done", "")`);
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      join(box.board, "sessions.json"),
      JSON.stringify({
        "TASK-1": [{ id: "a", transcript: transcript("a", 0.5), started: now }],
        "TASK-2": [
          { id: "b", transcript: transcript("b", 4), started: now - 3 * 86400 },
          { id: "c", transcript: transcript("c", 2), started: now },
          { id: "gone", transcript: join(box.dir, "gone.jsonl"), started: now },
        ],
        "TASK-3": [{ id: "d", transcript: transcript("d", 9), started: now }],
      }),
    );
  });

  test("card_costs: each card's sessions' costs, today's apart, a log that's gone left out", () => {
    const costs = box.lua(`return require("corkboard.usage").card_costs()`);
    expect(costs["TASK-1"]).toEqual({ cost: 0.5, today: 0.5, sessions: 1, tokens: 18 + 14900 + 8010 + 180 });
    expect(costs["TASK-2"]).toMatchObject({ cost: 6, today: 2, sessions: 2 });
  });

  // check() with the limits given, then the cards; sessions running for ids.
  const check = (limits: object, running: string[] = [], again = false) =>
    box.lua(
      `for k, v in pairs(input.limits) do vim.g["corkboard_budget_" .. k] = v end
      require("corkboard.agents").session = function(id) return vim.tbl_contains(input.running, id) and 1 or nil end
      local budget, cards = require("corkboard.budget"), require("corkboard.cards")
      local costs = require("corkboard.usage").card_costs()
      budget.check(cards.list(), costs)
      if input.again then budget.check(cards.list(), costs) end`,
      { limits, running, again },
    );

  test("a card past its limit is flagged once, its agent left alone, and a done one not at all", () => {
    check({ card: 5 }, [], true);
    expect(card("TASK-2")).toMatchObject({ over_budget: "card:5", attention: "over budget: $6.00 of the $5.00 card limit" });
    expect(card("TASK-2").budget_hold).toBeUndefined();
    expect(card("TASK-2").body.match(/corkboard: over budget/g)).toHaveLength(1);
    expect(card("TASK-1").over_budget).toBeUndefined();
    expect(card("TASK-3").over_budget).toBeUndefined();
  });

  test("with block, the agent is held until the user answers", () => {
    check({ card: 1, block: true });
    expect(card("TASK-2")).toMatchObject({ budget_hold: "over budget: $6.00 of the $1.00 card limit", agent_state: "blocked" });
    expect(card("TASK-2").body).toContain("; the agent is held until you answer");
  });

  test("the day's limit flags only the cards with a session running", () => {
    // Today: 0.5 + 2 + 9 (the done card's session counts too).
    check({ day: 10 }, ["TASK-1"]);
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(card("TASK-1")).toMatchObject({ over_budget: `day:${day}`, attention: "daily budget reached: $11.50 of $10.00 today" });
    expect(card("TASK-2").over_budget).toBeUndefined();
  });

  test("no limits, no flags", () => {
    check({});
    expect(card("TASK-2").over_budget).toBeUndefined();
  });
});
