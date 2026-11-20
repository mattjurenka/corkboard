// The Git tab's m (merge the pull request) and d (remove the worktree), and
// the review's A (approve) and S (send back), on real repositories: origin
// is served over HTTP as the node's forge (so fetches and the forge's
// owner/repo are real), and the bridge's forge ops are a stand-in that
// merges on origin as the forge would.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../mcp/cards";
import { type Sandbox, sandbox } from "./testing";

// Each test starts several Neovims and git over HTTP.
setDefaultTimeout(30_000);

let box: Sandbox;
afterEach(() => box?.cleanup());

// The bridge as the Git tab and the review use it: git_forge lists
// input.prs, pr_merge merges the PR's head into main on origin (unless
// input.refuse), and vim.ui.select takes the first choice. What was asked
// and said is in `calls` and `said`.
const BRIDGE = String.raw`
local calls, said = {}, {}
local cloud = require("corkboard.cards.cloud")
cloud.call_async = function(op, cb, ...)
  table.insert(calls, { op = op, args = { ... } })
  if op == "git_forge" then return cb(nil, { prs = vim.deepcopy(input.prs or {}), repos = {} }) end
  if op == "pr_merge" then
    local repo, number = ...
    if input.refuse then return cb(input.refuse) end
    local pr
    for _, p in ipairs(input.prs or {}) do if p.number == number then pr = p end end
    local head = pr and pr.head or input.head
    local r = vim.system({ "sh", "-c", input.merge, "merge", head }):wait()
    if r.code ~= 0 then return cb(r.stderr) end
    return cb(nil, { into = "main", sha = vim.trim(r.stdout) })
  end
  cb("no " .. op)
end
vim.ui.select = function(items, _, choose)
  table.insert(calls, { op = "select", items = items })
  choose(items[1], 1)
end
vim.notify = function(msg) table.insert(said, msg) end
`;

// The shell the stand-in merges with: $1 into main on origin, as the forge
// merges a pull request; prints the merge's sha.
const merge = (b: Sandbox) =>
  `set -e; d=$(mktemp -d "${b.dir}/merge.XXXXXX"); git clone --quiet "${b.origin}" "$d"; cd "$d"; git merge --quiet --no-ff -m "Merge $1" "origin/$1"; git push --quiet origin main; git rev-parse HEAD`;

function commit(dir: string, file: string, text: string, push?: string) {
  writeFileSync(join(dir, file), text);
  box.git(["add", file], dir);
  box.git(["commit", "--quiet", "-m", `add ${file}`], dir);
  if (push) box.git(["push", "--quiet", "origin", push], dir);
}

const branches = () => box.git(["branch", "--format=%(refname:short)"]).split("\n").sort();
const worktree = (name: string): [string, string] =>
  box.lua(`return { require("corkboard.worktree").make(require("corkboard.util").repo_root(vim.fn.getcwd()), input) }`, name);

// The Git tab opened, and waited on until its listing has input.listed's
// lines (its worktrees and PRs, as it found them).
const TAB = String.raw`
local git = require("corkboard.git")
git.open()
local function listing() return table.concat(vim.api.nvim_buf_get_lines(vim.fn.bufnr("agent://git"), 0, -1, false), "\n") end
assert(vim.wait(10000, function()
  for _, want in ipairs(input.listed) do
    if not listing():find(want, 1, true) then return false end
  end
  return true
end, 20), "the Git tab never listed it all:\n" .. listing())
`;

describe("the Git tab", () => {
  test("m merges the worktree's pull request on the forge, then removes the worktree and branch and brings main up", () => {
    box = sandbox({ forge: true });
    const [dir, branch] = worktree("s1");
    commit(dir, "feature.txt", "done\n", branch);
    const pr = { repo: "me/project", number: 7, head: branch, base: "main", url: "http://x/7", updated: "2026-11-20T10:00:00Z", title: "Feature" };
    const got = box.lua(
      `${BRIDGE}${TAB}
      -- m on the worktree is m on its pull request, which the tab matched to it.
      local line = listing():match("[^\\n]*agent/s1/work[^\\n]*")
      git.action("merge", "wt:" .. input.dir)
      vim.wait(10000, function() return #said > 0 end)
      local merged = vim.tbl_filter(function(c) return c.op == "pr_merge" end, calls)[1]
      return { line = line, calls = vim.tbl_map(function(c) return c.op end, calls), merge = merged and merged.args, said = said }`,
      { prs: [pr], merge: merge(box), dir, listed: ["Feature", "agent/s1/work"] },
    );
    expect(got.line).toMatch(/#7$/);
    expect(got.merge).toEqual(["me/project", 7, true]);
    expect(got.calls).toContain("select");
    expect(got.said.join("\n")).toContain("#7 merged into main");
    expect(existsSync(dir)).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(readFileSync(join(box.repo, "feature.txt"), "utf8")).toBe("done\n");
  });

  test("a merge the forge refuses leaves everything", () => {
    box = sandbox({ forge: true });
    const [dir, branch] = worktree("s1");
    commit(dir, "feature.txt", "done\n", branch);
    const pr = { repo: "me/project", number: 7, head: branch, base: "main", url: "http://x/7", updated: "2026-11-20T10:00:00Z", title: "Feature" };
    const said: string[] = box.lua(
      `${BRIDGE}${TAB}
      git.action("merge", "pr:me/project#7")
      vim.wait(10000, function() return #said > 0 end)
      return said`,
      { prs: [pr], merge: merge(box), refuse: "checks failed", listed: ["Feature", "agent/s1/work"] },
    );
    expect(said.join("\n")).toContain("merging #7 failed: checks failed");
    expect(existsSync(dir)).toBe(true);
    expect(branches()).toContain(branch);
  });

  test("d removes a worktree with nothing only it has, keeps one with work in it, and never the main checkout", () => {
    box = sandbox({ forge: true });
    const [clean] = worktree("clean");
    const [dirty] = worktree("dirty");
    writeFileSync(join(dirty, "wip.txt"), "wip");
    const said: string[] = box.lua(
      `${BRIDGE}${TAB}
      for _, key in ipairs({ "wt:" .. input.clean, "wt:" .. input.dirty, "wt:" .. input.main }) do
        git.action("drop", key)
        vim.wait(300)
      end
      return said`,
      { clean, dirty, main: box.repo, merge: "", listed: ["agent/clean/work", "agent/dirty/work", "1 changed"] },
    );
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(said).toContain(`corkboard: ${dirty} has uncommitted changes, so it's kept`);
    expect(said).toContain(`corkboard: ${box.repo} is the main checkout`);
    expect(branches()).toEqual(["agent/dirty/work", "main"]);
  });
});

describe("the review", () => {
  const board = () => box.board;
  const card = (id: string) => parse(join(board(), "tasks", `${id.toLowerCase()} - Feature.md`))!;
  // A card with its agent's work in a worktree, and maybe a pull request.
  function working(pr?: number): { dir: string; branch: string } {
    const [dir, branch] = worktree("task-1");
    box.lua(
      `local cards = require("corkboard.cards")
      cards.create("Feature", "review", "Add a feature.")
      cards.set("TASK-1", { worktree = input.dir, branch = input.branch, pr = input.pr or "", agent_state = "needs-review", attention = "review me" })`,
      { dir, branch, pr: pr ? String(pr) : null },
    );
    return { dir, branch };
  }
  const approve = (input: object) =>
    box.lua(
      `${BRIDGE}
      local finished = false
      require("corkboard.review").approve("TASK-1", function() finished = true end)
      -- Done, or it said why not.
      vim.wait(10000, function() return finished or #said > 0 end)
      vim.wait(50, function() return finished end)
      return { finished = finished, said = said, calls = vim.tbl_map(function(c) return c.op end, calls) }`,
      { merge: merge(box), ...input },
    );

  test("A without a pull request merges the branch into the main checkout, --no-ff, and finishes the card", () => {
    box = sandbox();
    const { dir, branch } = working();
    commit(dir, "feature.txt", "done\n");
    const got = approve({});
    expect(got.finished).toBe(true);
    expect(box.git(["log", "-1", "--format=%s %p"])).toMatch(/^Merge TASK-1: Feature \S+ \S+$/);
    expect(readFileSync(join(box.repo, "feature.txt"), "utf8")).toBe("done\n");
    expect(existsSync(dir)).toBe(false);
    expect(branches()).toEqual(["main"]);
    const c = card("TASK-1");
    expect(c).toMatchObject({ status: "done", agent_state: "done" });
    expect(c.attention).toBeUndefined();
    expect(c.worktree).toBeUndefined();
    expect(c.body).toMatch(new RegExp(`user: approved: merged ${branch} into main \\(\\w+\\)\\n`));
  });

  test("A with a pull request merges it on the forge, then finishes the worktree and the card", () => {
    box = sandbox({ forge: true });
    const { dir, branch } = working(7);
    commit(dir, "feature.txt", "done\n", branch);
    const got = approve({ head: branch });
    expect(got.calls).toEqual(["select", "pr_merge"]);
    expect(got.finished).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(readFileSync(join(box.repo, "feature.txt"), "utf8")).toBe("done\n");
    const c = card("TASK-1");
    expect(c).toMatchObject({ status: "done", agent_state: "done" });
    expect(c.body).toMatch(/user: approved: merged #7 into main \(\w{10}\)\n/);
  });

  test("A with commits not pushed to the pull request waits for them", () => {
    box = sandbox({ forge: true });
    const { dir, branch } = working(7);
    commit(dir, "feature.txt", "done\n", branch);
    commit(dir, "more.txt", "more\n");
    const got = approve({ head: branch });
    expect(got.finished).toBe(false);
    expect(got.calls).toEqual([]);
    expect(got.said.join("\n")).toContain("TASK-1's worktree has commits not pushed to #7");
    expect(existsSync(dir)).toBe(true);
  });

  test("A with uncommitted work in the worktree, or a branch that won't merge, merges nothing", () => {
    box = sandbox();
    const { dir } = working();
    writeFileSync(join(dir, "README.md"), "theirs\n");
    expect(approve({}).said.join("\n")).toContain("TASK-1's worktree has uncommitted changes");
    box.git(["commit", "--quiet", "-am", "theirs"], dir);
    commit(box.repo, "README.md", "ours\n");
    const got = approve({});
    expect(got.finished).toBe(false);
    expect(got.said.join("\n")).toContain("merging agent/task-1/work failed");
    // Left as it was: nothing half merged, the card says why.
    expect(box.git(["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(box.repo, "README.md"), "utf8")).toBe("ours\n");
    expect(card("TASK-1").attention).toBe("merging agent/task-1/work failed; resolve it in the worktree and approve again");
    expect(existsSync(dir)).toBe(true);
  });

  test("A on a card with no work to merge just finishes it", () => {
    box = sandbox();
    box.lua(`require("corkboard.cards").create("Feature", "review", "") require("corkboard.cards").set("TASK-1", { attention = "x" })`);
    expect(approve({}).finished).toBe(true);
    expect(card("TASK-1")).toMatchObject({ status: "done", agent_state: "done" });
    expect(card("TASK-1").body).toMatch(/user: approved\n/);
  });

  test("S sends it back: logged, back to doing, and queued for a session in the same worktree", () => {
    box = sandbox();
    const { dir } = working();
    // No agent to start here: the stand-in for agents.start says what it was asked.
    const got = box.lua(
      `local agents = require("corkboard.agents")
      local started
      agents.start = function(id, opts) started = { id = id, opts = opts } end
      local closed = false
      require("corkboard.review").send_back("TASK-1", function() closed = true end)
      return { started = started, closed = closed }`,
    );
    expect(got).toEqual({ started: { id: "TASK-1", opts: { sent_back: true } }, closed: true });
    const c = card("TASK-1");
    expect(c).toMatchObject({ status: "doing", agent_state: "queued", worktree: dir });
    expect(c.attention).toBeUndefined();
    expect(c.body).toMatch(/user: sent back from review\n/);
  });
});
