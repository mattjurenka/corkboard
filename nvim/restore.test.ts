// The editor as it was (corkboard.restore): one Neovim lays out tabs and
// splits and saves them to editor.json beside the board; the next one for
// the project puts them back, after the pinned tabs.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox();
afterAll(() => box.cleanup());
const saved = join(box.board, "editor.json");
const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
const a = box.write("a.txt", lines);
const b = box.write("src/b.txt", lines);
const c = box.write("c.txt", "c\n");

// No bridge: the Git tab's forge calls fail as they do signed out.
// What the first Neovim showed as it saved.
let shown: { tabs: any[]; current: string };

const OFFLINE = `require("corkboard.cards.cloud").call_async = function(_, cb) cb("offline") end\n`;

// Each tab as its windows: what they show, and the cursor's file.
const LAYOUT = String.raw`
local tabs = {}
for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
  local wins = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    local buf = vim.api.nvim_win_get_buf(win)
    table.insert(wins, {
      name = vim.api.nvim_buf_get_name(buf),
      buftype = vim.bo[buf].buftype,
      line = vim.api.nvim_win_get_cursor(win)[1],
    })
  end
  table.insert(tabs, { wins = wins, layout = vim.fn.winlayout(vim.api.nvim_tabpage_get_number(tab))[1] })
end
local current = vim.api.nvim_buf_get_name(0)
`;

describe("save", () => {
  test("waits until the state is put back, then writes the tabs, splits, files and cursors", () => {
    rmSync(saved, { force: true });
    const got = box.lua(
      `${OFFLINE}
      local restore = require("corkboard.restore")
      restore.save()
      local before = vim.uv.fs_stat(input.saved) ~= nil
      restore.restore()
      -- As the editor has them: the pinned tabs, then the user's.
      require("corkboard.board").ensure()
      require("corkboard.git").ensure()
      require("corkboard.usage").ensure()
      vim.cmd("$tabnew " .. input.a)
      vim.cmd("vsplit " .. input.b)
      vim.api.nvim_win_set_cursor(0, { 40, 3 })
      vim.cmd("$tabnew " .. input.c)
      vim.cmd("split")
      vim.cmd.enew()
      vim.cmd.terminal()
      vim.cmd.tabprevious()
      restore.save()
      ${LAYOUT}
      return { before = before, state = restore.state(), tabs = tabs, current = current }`,
      { a, b, c, saved },
    );
    expect(got.before).toBe(false);
    const file = JSON.parse(readFileSync(saved, "utf8"));
    expect(file).toEqual(got.state);
    expect(file.current).toBe(got.tabs.length - 1);
    shown = got;
    expect(file.tabs).toHaveLength(2);
    const [first, second] = file.tabs;
    expect(first.layout[0]).toBe("row");
    expect(first.layout[1].map((l: any) => [l[1].type, l[1].path, l[1].lnum, l[1].focus ?? false])).toEqual([
      ["file", b, 40, true],
      ["file", a, 1, false],
    ]);
    expect(second.layout[0]).toBe("col");
    expect(second.layout[1].map((l: any) => [l[1].type, l[1].path ?? l[1].cwd])).toEqual([
      ["terminal", box.repo],
      ["file", c],
    ]);
  });

  test("nothing at home, where there's no project", () => {
    const home = box.lua(
      `${OFFLINE}
      local restore = require("corkboard.restore")
      restore.restore()
      vim.cmd.edit(input)
      restore.save()
      return vim.uv.fs_stat(require("corkboard.cards").dir() .. "/editor.json") ~= nil`,
      a,
      { cwd: box.home },
    );
    expect(home).toBe(false);
  });
});

describe("restore", () => {
  test("the next Neovim puts back the tabs after the pinned ones, the files at their lines, and a shell", () => {
    const got = box.lua(
      `${OFFLINE}
      require("corkboard.restore").restore()
      vim.wait(200)
      ${LAYOUT}
      local pinned = {}
      for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
        for _, key in ipairs({ "corkboard_board", "corkboard_git", "corkboard_usage" }) do
          if vim.t[tab][key] then table.insert(pinned, key) end
        end
      end
      return { tabs = tabs, current = current, pinned = pinned, restored = require("corkboard.restore").restored() }`,
    );
    expect(got.restored).toBe(true);
    expect(got.pinned).toEqual(["corkboard_board", "corkboard_git", "corkboard_usage"]);
    // Every tab where it was, each window showing what it did, a file at its
    // line; a shell is a new one.
    const same = (tabs: any[]) =>
      tabs.map((t) => ({ layout: t.layout, wins: t.wins.map((w: any) => (w.buftype === "terminal" ? "terminal" : w.name.startsWith("agent://") ? w.name : [w.name, w.line])) }));
    expect(same(got.tabs)).toEqual(same(shown.tabs));
    const mine = got.tabs.slice(-2);
    expect(mine[0].layout).toBe("row");
    expect(mine[0].wins.map((w: any) => [w.name, w.line])).toEqual([
      [b, 40],
      [a, 1],
    ]);
    expect(mine[1].layout).toBe("col");
    expect(mine[1].wins.map((w: any) => w.buftype)).toEqual(["terminal", ""]);
    expect(mine[1].wins[1].name).toBe(c);
    // The tab and window that had the cursor.
    expect(got.current).toBe(b);
  });

  test("sessions are resumed: a card's by its agent, one that never wrote a transcript started afresh", () => {
    const was = readFileSync(saved, "utf8");
    const transcript = box.write(join(box.dir, "t.jsonl"), "{}\n");
    const leaf = (l: object) => ["leaf", { width: 80, height: 20, ...l }];
    box.write(
      saved,
      JSON.stringify({
        current: 4,
        columns: 80,
        lines: 24,
        tabs: [
          { layout: leaf({ type: "agent", agent: "claude", session: "s-card", card: "TASK-1", brain: "work", cwd: box.repo, transcript }) },
          { layout: leaf({ type: "agent", agent: "claude", session: "s-linked", linked: "TASK-1", cwd: box.repo, transcript }) },
          { layout: leaf({ type: "agent", agent: "codex", session: "s-new", cwd: box.repo, transcript: join(box.dir, "never.jsonl") }) },
        ],
      }),
    );
    const got = box.lua(`${OFFLINE}
      require("corkboard.cards").create("Feature", "doing", "")
      local started, linked = {}, {}
      local agents, session = require("corkboard.agents"), require("corkboard.session")
      agents.start = function(id, opts) table.insert(started, { card = id, opts = opts }) end
      agents.link = function(_, id) table.insert(linked, id) end
      session.start = function(opts) table.insert(started, { opts = opts }) return vim.api.nvim_get_current_buf() end
      require("corkboard.restore").restore()
      return { started = started, linked = linked }`);
    expect(got.started).toEqual([
      { card: "TASK-1", opts: { resume: "s-card", here: true, brain: "work" } },
      { opts: { agent: "claude", cwd: box.repo, resume: "s-linked", here: true } },
      { opts: { agent: "codex", cwd: box.repo, here: true } },
    ]);
    expect(got.linked).toEqual(["TASK-1"]);
    box.write(saved, was);
  });

  test("a file that's gone leaves its window empty, and a broken editor.json is no state", () => {
    rmSync(b);
    const got = box.lua(`${OFFLINE}
      require("corkboard.restore").restore()
      ${LAYOUT}
      return tabs`);
    expect(got.slice(-2)[0].wins.map((w: any) => w.name)).toEqual(["", a]);
    box.write(saved, "{ not json");
    const tabs = box.lua(`${OFFLINE}
      require("corkboard.restore").restore()
      ${LAYOUT}
      return { tabs = #tabs, restored = require("corkboard.restore").restored() }`);
    expect(tabs).toEqual({ tabs: 1, restored: true });
    expect(existsSync(saved)).toBe(true);
  });
});
