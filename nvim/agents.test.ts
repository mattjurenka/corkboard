// Agents on cards (corkboard.agents) in a real Neovim with real terminals:
// starting one in its worktree, scheduling the queue, taking a card in a
// session, and what a session's hook events do to its card. The agent is a
// stand-in claude on PATH that writes down how it was started, then waits.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Card, parse } from "../mcp/cards";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox();
afterAll(() => box.cleanup());
const started = join(box.dir, "started");
box.stub("claude", `{ pwd; printf '%s\\n' "$@"; echo "CARD=$CORKBOARD_CARD BOARD=$CORKBOARD_BOARD AGENT=$CORKBOARD_AGENT"; } > "${started}"; exec cat`);

const card = (id: string): Card => {
  const tasks = join(box.board, "tasks");
  return parse(join(tasks, readdirSync(tasks).find((n) => n.startsWith(`${id.toLowerCase()} - `))!))!;
};

beforeEach(() => {
  box.lua(`
    local cards = require("corkboard.cards")
    pcall(vim.fn.delete, cards.dir(), "rf")
    cards.create("First", "ready", "Do the first thing.")
    cards.create("Second", "ready", "")
    cards.create("Third", "ready", "")
    cards.set("TASK-3", { dependencies = { "TASK-1" } })`);
});

describe("start", () => {
  test("the card's agent in its own worktree, told the card and given the board", () => {
    Bun.spawnSync(["rm", "-f", started]);
    const got = box.lua(`
      local agents = require("corkboard.agents")
      agents.start("TASK-1")
      vim.wait(5000, function() return vim.uv.fs_stat(input) ~= nil end)
      vim.wait(100)
      local buf = agents.session("TASK-1")
      return { live = agents.live("TASK-1"), card = buf and vim.b[buf].corkboard_card, running = agents.running() }`, started);
    expect(got).toEqual({ live: "starting", card: "TASK-1", running: 1 });
    const [cwd, ...rest] = readFileSync(started, "utf8").trim().split("\n");
    const wt = join(box.home, ".local/share/corkboard/worktrees", box.repo.slice(1).replaceAll("/", "-"), "task-1");
    expect(cwd).toBe(wt);
    expect(rest.join("\n")).toContain('You are working on corkboard card TASK-1: "First", in a git worktree of your own, on branch agent/task-1/work.');
    expect(rest.at(-1)).toBe(`CARD=TASK-1 BOARD=${box.board} AGENT=claude`);
    expect(card("TASK-1")).toMatchObject({ agent: "claude", worktree: wt, branch: "agent/task-1/work" });
  });

  test("a worktree it can't make blocks the card and says why", () => {
    // main is the main checkout's, so it can't be the card's too.
    box.git(["branch", "card/task-2", "main"]);
    box.git(["worktree", "add", "--quiet", join(box.dir, "elsewhere"), "card/task-2"]);
    box.lua(`require("corkboard.agents").start("TASK-2")`);
    const c = card("TASK-2");
    expect(c.agent_state).toBe("blocked");
    expect(c.attention).toMatch(/^could not make a worktree: git worktree add: /);
    box.git(["worktree", "remove", "--force", join(box.dir, "elsewhere")]);
  });
});

describe("schedule", () => {
  // What the board's push schedules from the cards as they are, with room
  // for max.
  const schedule = (max: number, attached = true) =>
    box.lua(
      `local agents = require("corkboard.agents")
      require("corkboard").attached = function() return input.attached end
      vim.g.corkboard_max_agents = input.max
      local started = {}
      agents.start = function(id) table.insert(started, id) end
      vim.g.corkboard_groom_minutes = 0
      -- As the board does on every change, from the cards it shows.
      require("corkboard.board").push()
      vim.wait(100)
      return started`,
      { max, attached },
    );

  beforeEach(() => {
    box.lua(`
      local cards = require("corkboard.cards")
      for _, id in ipairs({ "TASK-1", "TASK-2", "TASK-3" }) do cards.set(id, { agent_state = "queued" }) end`);
  });

  test("queued cards whose dependencies are done, up to the limit", () => {
    expect(schedule(3)).toEqual(["TASK-1", "TASK-2"]);
    expect(schedule(1)).toEqual(["TASK-1"]);
    box.lua(`require("corkboard.cards").set("TASK-1", { status = "done", agent_state = "done" })`);
    expect(schedule(3)).toEqual(["TASK-2", "TASK-3"]);
  });

  test("nothing in a Neovim nobody is looking at", () => {
    expect(schedule(3, false)).toEqual([]);
  });
});

describe("take", () => {
  test("types the claim into the session, and an ended one is said to have ended", () => {
    const got = box.lua(`
      local said = {}
      vim.notify = function(m) table.insert(said, m) end
      local agents = require("corkboard.agents")
      vim.cmd.enew()
      vim.fn.jobstart({ "cat" }, { term = true })
      local buf = vim.api.nvim_get_current_buf()
      agents.take(buf, "TASK-2")
      vim.wait(2000, function() return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false)):find("work on it") ~= nil end)
      local screen = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "")
      vim.fn.jobstop(vim.b[buf].terminal_job_id)
      vim.wait(1000, function() return not require("corkboard.terminal").alive(buf) end)
      agents.take(buf, "TASK-2")
      return { screen = screen, said = said }`);
    expect(got.screen).toContain("Take corkboard card TASK-2: call claim_card with id TASK-2, read the card, and work on it.");
    expect(got.said).toEqual(["corkboard: that session has ended"]);
  });
});

describe("hook", () => {
  // Each event in turn on a session's buffer working on card (if any): the
  // card's fields and the session's state after each.
  const hook = (events: object[], card?: string) =>
    box.lua(
      `local agents = require("corkboard.agents")
      local cards = require("corkboard.cards")
      local buf = vim.api.nvim_create_buf(true, false)
      vim.b[buf].corkboard_card = input.card
      local out = {}
      for _, ev in ipairs(input.events) do
        ev.buf = buf
        agents.hook(ev)
        local id = vim.b[buf].corkboard_card
        local c = id and cards.get(id)
        table.insert(out, { state = agents.state(buf) or vim.NIL, card = id or vim.NIL, agent_state = c and c.agent_state or vim.NIL,
          attention = c and c.attention or vim.NIL, asking = vim.b[buf].corkboard_asking or vim.NIL, session = vim.b[buf].corkboard_agent_session or vim.NIL })
      end
      vim.wait(50)
      return out`,
      { events, card: card ?? null },
    );

  test("a question blocks the card with it; answered, it's working again", () => {
    box.lua(`require("corkboard.cards").set("TASK-1", { agent_state = "working" })`);
    const steps = hook(
      [
        { event: "turn" },
        { event: "asking", question: "Which one?" },
        { event: "permission", tool_name: "AskUserQuestion" },
        { event: "tool_done" },
        { event: "permission", tool_name: "Bash" },
        { event: "permission", tool_name: "Bash", noticed: true },
        { event: "tool" },
        { event: "settled" },
      ],
      "TASK-1",
    );
    expect(steps.map((s: any) => [s.state, s.agent_state, s.attention])).toEqual([
      ["working", "working", null],
      ["asking", "blocked", "asks: Which one?"],
      // The question's dialog is its permission prompt too.
      ["asking", "blocked", "asks: Which one?"],
      ["working", "working", null],
      ["permission", "blocked", "wants permission for Bash"],
      // A Notification of the same prompt says nothing new.
      ["permission", "blocked", "wants permission for Bash"],
      ["working", "working", null],
      ["ready", "working", null],
    ]);
    expect(steps[1].asking).toBe("asks: Which one?");
    expect(steps[3].asking).toBeNull();
  });

  test("a start remembers the session for the card, and its cost later", () => {
    const transcript = join(box.dir, "s1.jsonl");
    const steps = hook([{ event: "start", session: "s1", transcript }], "TASK-1");
    expect(steps[0]).toMatchObject({ state: "idle", session: "s1" });
    const sessions = JSON.parse(readFileSync(join(box.board, "sessions.json"), "utf8"));
    expect(sessions["TASK-1"]).toEqual([{ id: "s1", transcript, started: expect.any(Number) }]);
    // Again is the same session, not another.
    hook([{ event: "start", session: "s1", transcript }], "TASK-1");
    expect(JSON.parse(readFileSync(join(box.board, "sessions.json"), "utf8"))["TASK-1"]).toHaveLength(1);
  });

  test("a session not started on a card takes one by claiming it and lets it go by releasing it", () => {
    const steps = hook([
      { event: "tool_done", corkboard_tool: "claim_card", card: "TASK-2" },
      { event: "tool_done", corkboard_tool: "next_card", card: "TASK-3" },
      // Another card's release isn't this one's.
      { event: "tool_done", corkboard_tool: "release_card", card: "TASK-2" },
      { event: "tool_done", corkboard_tool: "release_card", card: "TASK-3" },
    ]);
    expect(steps.map((s: any) => s.card)).toEqual(["TASK-2", "TASK-3", "TASK-3", null]);
  });

  test("a handoff is kept where the next session reads it", () => {
    hook([{ event: "settled", session: "s9", handoff: "Where I got to.", handoff_title: "  The  parser " }], "TASK-1");
    const path = join(box.home, ".local/state/nvim/corkboard/handoffs/s9.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("# The parser\n\nWhere I got to.\n");
  });
});
