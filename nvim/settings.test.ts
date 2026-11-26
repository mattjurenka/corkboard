// The Settings tab's two pages (corkboard.settings, corkboard.brains) in one
// window, and the session pick (corkboard.session) as the page is sent it.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox();
afterAll(() => box.cleanup());
box.stub("claude", "exec cat");

// No bridge: what the pages would load fails as it does signed out.
const OFFLINE = `require("corkboard.cards.cloud").call_async = function(_, cb) cb("offline") end\n`;

describe("the Settings tab", () => {
  test("the brains and the settings swap in its one window, and what the brains opened beside them closes", () => {
    const got = box.lua(`${OFFLINE}
      local settings = require("corkboard.settings")
      local shown = {}
      local function note()
        table.insert(shown, { tabs = #vim.api.nvim_list_tabpages(), wins = #vim.api.nvim_tabpage_list_wins(0), name = vim.api.nvim_buf_get_name(0) })
      end
      local tabs = #vim.api.nvim_list_tabpages()
      settings.open("brains")
      note()
      local win = vim.api.nvim_get_current_win()
      -- As a brain's memory is, beside the brains.
      vim.cmd("botright vsplit")
      local memory = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(memory, "agent://brains/work")
      vim.api.nvim_win_set_buf(0, memory)
      settings.open()
      note()
      local same = vim.api.nvim_get_current_win() == win
      require("corkboard.brains").show()
      note()
      vim.cmd("tabfirst")
      settings.open()
      note()
      return { before = tabs, shown = shown, same = same and vim.api.nvim_get_current_win() == win }`);
    const tabs = got.before + 1;
    expect(got.shown).toEqual([
      { tabs, wins: 1, name: "agent://brains" },
      { tabs, wins: 1, name: "agent://settings" },
      { tabs, wins: 1, name: "agent://brains" },
      { tabs, wins: 1, name: "agent://settings" },
    ]);
    expect(got.same).toBe(true);
  });

  test("<Tab> on either goes to the other; brains isn't a pinned tab", () => {
    const got = box.lua(`${OFFLINE}
      require("corkboard.settings").open()
      local names = {}
      for _ = 1, 2 do
        vim.api.nvim_feedkeys(vim.keycode("<Tab>"), "x", false)
        table.insert(names, vim.api.nvim_buf_get_name(0))
      end
      return { names = names, index = require("corkboard.pinned").index("corkboard_brains") or vim.NIL }`);
    expect(got).toEqual({ names: ["agent://brains", "agent://settings"], index: null });
  });
});

describe("the session pick", () => {
  const PICK = `${OFFLINE}
    local corkboard = require("corkboard")
    local sent, started = {}, {}
    corkboard.attached = function() return true end
    corkboard.notify = function(method, pick) if method == "corkboard.session" then table.insert(sent, pick) end end
    require("corkboard.brains").live = function() return { { name = "work" }, { name = "home" } } end
    require("corkboard.board").set = function(id, fields) table.insert(started, { "set", id, fields.agent }) end
    require("corkboard.agents").start = function(id, opts) table.insert(started, { "start", id, opts.brain or vim.NIL }) end
    local session = require("corkboard.session")
    local last = vim.fs.joinpath(vim.fn.stdpath("state"), "corkboard", "picked.json")
  `;

  test("the page is sent the columns, each leaf by an id; the one it chooses runs, and the next pick opens on it", () => {
    const got = box.lua(`${PICK}
      session.open_card("TASK-1")
      local first = sent[1]
      local leaf = first.items[2].items[1].items[1]
      session.run(leaf.id)
      -- Once: the pick is over.
      session.run(leaf.id)
      vim.wait(200, function() return #started == 2 end)
      session.open_card("TASK-1")
      return { first = first, leaf = leaf, started = started, again = sent[2].last, floats = #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative ~= "" end, vim.api.nvim_list_wins()) }`);
    expect(got.first.title).toBe("TASK-1");
    expect(got.first.last).toBeUndefined();
    expect(got.first.items.map((it: any) => it.text)).toEqual(["work", "home", "no brain"]);
    const agent = got.first.items[1].items[0];
    expect(got.leaf).toMatchObject({ text: "here", id: expect.any(Number) });
    expect(got.started).toEqual([
      ["set", "TASK-1", expect.any(String)],
      ["start", "TASK-1", "home"],
    ]);
    expect(got.again).toEqual(["home", agent.text, "here"]);
    expect(got.floats).toBe(0);
  });

  test("in a bare Neovim, a vim.ui.select for each column", () => {
    const got = box.lua(`${PICK}
      corkboard.attached = function() return false end
      local asked = {}
      vim.ui.select = function(list, opts, cb)
        table.insert(asked, { opts.prompt, vim.tbl_map(opts.format_item, list) })
        cb(list[1])
      end
      session.open_card("TASK-2")
      vim.wait(200, function() return #started == 2 end)
      return { asked = asked, started = started, sent = #sent }`);
    expect(got.sent).toBe(0);
    expect(got.asked.map((a: any) => a[0])).toEqual(["TASK-2", "work", expect.any(String)]);
    expect(got.asked[0][1]).toEqual(["work", "home", "no brain"]);
    expect(got.asked[2][1][0]).toStartWith("here  ");
    expect(got.started.at(-1)).toEqual(["start", "TASK-2", "work"]);
  });
});
