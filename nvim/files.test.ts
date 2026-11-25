// What keeps Neovim's loop free while the disk is busy: the file browser's
// folders (corkboard.list_dir), read by git off the loop and sent back as
// corkboard.dir, and util.write_later, which writes a file off it.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox();
afterAll(() => box.cleanup());

// list_dir's answer: what it notified, and whether it had returned first.
const LIST = String.raw`
local cb = require("corkboard")
local got, returned
cb.notify = function(method, id, entries) got = { method = method, id = id, entries = entries, early = not returned } end
cb.list_dir(input.dir, "page.1")
returned = true
vim.wait(5000, function() return got ~= nil end, 5)
return got
`;

describe("list_dir", () => {
  box.write("src/a.ts", "a\n");
  box.write("src/b.ts", "b\n");
  box.write("notes.log", "x\n");
  box.write(".gitignore", "*.log\n");
  box.git(["add", "src/a.ts", ".gitignore"]);
  box.git(["commit", "--quiet", "-m", "src"]);
  box.write("src/a.ts", "a changed\n");

  test("answers after it returns, folders first, with git's marks", () => {
    const got = box.lua(LIST, { dir: box.repo });
    expect(got).toMatchObject({ method: "corkboard.dir", id: "page.1", early: false });
    expect(got.entries).toEqual([
      { name: "src", dir: true, git: "modified" },
      { name: ".gitignore", dir: false },
      { name: "notes.log", dir: false, ignored: true },
      { name: "README.md", dir: false },
    ]);
  });

  test("a subfolder's marks are its own entries'", () => {
    const got = box.lua(LIST, { dir: join(box.repo, "src") });
    expect(got.entries).toEqual([
      { name: "a.ts", dir: false, git: "modified" },
      { name: "b.ts", dir: false, git: "added" },
    ]);
  });

  test("a folder that's gone answers nil", () => {
    const got = box.lua(LIST, { dir: join(box.repo, "nowhere") });
    expect(got).toEqual({ method: "corkboard.dir", id: "page.1", entries: null, early: true });
  });
});

describe("write_later", () => {
  test("writes in order, the last asked for wins, and leaves no .tmp", () => {
    const dir = join(box.dir, "writes");
    const got = box.lua(
      String.raw`
      vim.fn.mkdir(input.dir, "p")
      local util = require("corkboard.util")
      local path = input.dir .. "/f.json"
      for i = 1, 5 do util.write_later(path, "v" .. i) end
      local after_call = vim.uv.fs_stat(path) ~= nil
      vim.wait(2000, util.written, 5)
      return { after_call = after_call, written = util.written() }`,
      { dir },
    );
    expect(got).toEqual({ after_call: false, written: true });
    expect(readFileSync(join(dir, "f.json"), "utf8")).toBe("v5");
    expect(readdirSync(dir)).toEqual(["f.json"]);
  });

  test("what's still on its way is written before Neovim quits", () => {
    const path = join(box.dir, "quit.json");
    box.lua(`require("corkboard.util").write_later(input.path, "bye")`, { path });
    expect(existsSync(path) && readFileSync(path, "utf8")).toBe("bye");
  });
});

describe("write_later's failures and deletes", () => {
  test("what's on its way is what's read, and a delete after a write leaves nothing", () => {
    const dir = join(box.dir, "queue");
    const got = box.lua(
      String.raw`
      vim.fn.mkdir(input.dir, "p")
      local util = require("corkboard.util")
      local path = input.dir .. "/f"
      vim.fn.writefile({ "old" }, path)
      util.write_later(path, "a\nb\n")
      local before = util.read_lines(path)
      util.delete_later(path)
      local deleting = util.read_lines(path)
      vim.wait(2000, util.written, 5)
      return { before = before, deleting = deleting or "none", after = util.read_lines(path) or "none" }`,
      { dir },
    );
    expect(got).toEqual({ before: ["a", "b"], deleting: "none", after: "none" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a write that can't land keeps what was there and leaves no .tmp", () => {
    const dir = join(box.dir, "fails");
    box.lua(
      String.raw`
      local util = require("corkboard.util")
      -- A folder in the way: the rename onto it fails.
      vim.fn.mkdir(input.dir .. "/f/inside", "p")
      util.write_later(input.dir .. "/f", "new")
      vim.wait(2000, util.written, 5)`,
      { dir },
    );
    expect(readdirSync(dir)).toEqual(["f"]);
    expect(readdirSync(join(dir, "f"))).toEqual(["inside"]);
  });
});

describe("recent projects", () => {
  test("forgetting one just remembered sticks, and so does its last-project's delete", () => {
    const a = join(box.dir, "proj-a");
    const b = join(box.dir, "proj-b");
    const got = box.lua(
      String.raw`
      vim.fn.mkdir(input.a, "p")
      vim.fn.mkdir(input.b, "p")
      local util, cb = require("corkboard.util"), require("corkboard")
      local state = util.state_dir()
      vim.fn.mkdir(state, "p")
      -- As remember_project leaves them, still on their way.
      util.write_later(state .. "/last-project", input.a .. "\n")
      util.write_later(state .. "/projects", input.a .. "\n" .. input.b .. "\n")
      local remembered = cb.recent_projects()
      cb.forget_project(input.a)
      vim.wait(2000, util.written, 5)
      return {
        remembered = remembered,
        left = cb.recent_projects(),
        last = vim.uv.fs_stat(state .. "/last-project") ~= nil,
      }`,
      { a, b },
    );
    expect(got).toEqual({ remembered: [a, b], left: [b], last: false });
  });
});
