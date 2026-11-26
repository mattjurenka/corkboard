// Agents' worktrees (corkboard.worktree) on real repositories: made from the
// main checkout's HEAD, finished after their pull request merges on the
// forge, dropped when their card is archived unmerged; and the Git tab's m
// and d (corkboard.git), which do the same from the list.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./testing";

let box: Sandbox;
afterEach(() => box?.cleanup());

const WT = `local wt = require("corkboard.worktree")\nlocal util = require("corkboard.util")\n`;
const branches = () => box.git(["branch", "--format=%(refname:short)"]).split("\n").sort();

// A commit in dir, pushed to origin when push.
function commit(dir: string, file: string, text: string, push?: string) {
  writeFileSync(join(dir, file), text);
  box.git(["add", file], dir);
  box.git(["commit", "--quiet", "-m", `add ${file}`], dir);
  if (push) box.git(["push", "--quiet", "origin", push], dir);
}

// As the forge merges a pull request: branch into main on origin.
function mergeOnOrigin(branch: string) {
  const clone = join(box.dir, `merge-${branch.replaceAll("/", "-")}`);
  box.git(["clone", "--quiet", box.origin, clone], box.dir);
  box.git(["merge", "--quiet", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`], clone);
  box.git(["push", "--quiet", "origin", "main"], clone);
}

describe("make", () => {
  test("a worktree under the data dir on agent/<name>/work, the same one after", () => {
    box = sandbox();
    const [dir, branch, again] = box.lua(`${WT}
      local dir, branch = wt.make(util.repo_root(vim.fn.getcwd()), "0101-120000")
      return { dir, branch, (wt.make(util.repo_root(vim.fn.getcwd()), "0101-120000")) }`);
    expect(dir).toBe(join(box.home, ".local/share/corkboard/worktrees", box.repo.slice(1).replaceAll("/", "-"), "0101-120000"));
    expect(branch).toBe("agent/0101-120000/work");
    expect(again).toBe(dir);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(box.git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe(branch);
  });

  test("a branch it's given, when there is one; its own when not", () => {
    box = sandbox();
    box.git(["branch", "card/task-3"]);
    const got = box.lua(`${WT}
      local root = util.repo_root(vim.fn.getcwd())
      return { select(2, wt.make(root, "task-3", "card/task-3")), select(2, wt.make(root, "task-4", "card/task-4")) }`);
    expect(got).toEqual(["card/task-3", "agent/task-4/work"]);
  });

  test("git's refusal is the error", () => {
    box = sandbox();
    // main is checked out in the main checkout.
    expect(() => box.lua(`${WT} wt.make(util.repo_root(vim.fn.getcwd()), "x", "main")`)).toThrow(/git worktree add: .*main/);
  });
});

describe("for_session", () => {
  test("from a subdirectory: the same place in a new worktree, and what to tell the agent", () => {
    box = sandbox();
    commit(box.repo, "keep", "");
    box.write("src/lib/a.ts", "");
    box.git(["add", "."]);
    box.git(["commit", "--quiet", "-m", "src"]);
    const [cwd, branch, note, linked] = box.lua(`${WT}
      local cwd, branch, note = wt.for_session(input)
      return { cwd, branch, note, wt.linked(cwd) }`, join(box.repo, "src/lib"));
    expect(cwd).toMatch(/\/worktrees\/[^/]+\/\d{4}-\d{6}\/src\/lib$/);
    expect(branch).toMatch(/^agent\/\d{4}-\d{6}\/work$/);
    expect(note).toContain(`on branch ${branch}, made from ${box.repo}'s HEAD`);
    expect(linked).toBe(true);
  });

  test("none in a linked worktree already, or outside a repository", () => {
    box = sandbox();
    box.git(["worktree", "add", "--quiet", join(box.dir, "mine"), "-b", "mine"]);
    const outside = join(box.dir, "bin");
    expect(box.lua(`${WT} return { wt.for_session(input[1]) or false, wt.for_session(input[2]) or false, wt.linked(input[2]), wt.linked(input[3]) }`, [join(box.dir, "mine"), outside, box.repo])).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("finish, after the pull request merged", () => {
  // A worktree with a pushed commit, merged on origin.
  function merged(): { dir: string; branch: string } {
    box = sandbox();
    const [dir, branch] = box.lua(`${WT} return { wt.make(util.repo_root(vim.fn.getcwd()), "task-1") }`);
    commit(dir, "feature.txt", "done\n", branch);
    mergeOnOrigin(branch);
    return { dir, branch };
  }
  const finish = (dir: string, branch: string) => box.lua(`${WT} return wt.finish(input[1], input[2], input[3], "main")`, [box.repo, dir, branch]);

  test("the worktree and branch go, and the main checkout comes up to the merge", () => {
    const { dir, branch } = merged();
    expect(finish(dir, branch)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(readFileSync(join(box.repo, "feature.txt"), "utf8")).toBe("done\n");
    expect(box.git(["status", "--porcelain"])).toBe("");
  });

  test("uncommitted work keeps the worktree and its branch", () => {
    const { dir, branch } = merged();
    writeFileSync(join(dir, "scratch.txt"), "wip");
    const left: string[] = finish(dir, branch);
    expect(left).toHaveLength(1);
    expect(left[0]).toStartWith("the worktree is still there: ");
    expect(existsSync(dir)).toBe(true);
    expect(branches()).toContain(branch);
    // The main checkout still comes up to date.
    expect(existsSync(join(box.repo, "feature.txt"))).toBe(true);
  });

  test("a main checkout on another branch, or with changes, is left as it is", () => {
    const { dir, branch } = merged();
    box.git(["checkout", "--quiet", "-b", "other"]);
    expect(finish(dir, branch)).toEqual([`${box.repo} is on other, not main; pull it yourself`]);
    box.git(["checkout", "--quiet", "main"]);
    writeFileSync(join(box.repo, "README.md"), "edited\n");
    expect(finish("", "")).toEqual([`${box.repo} has uncommitted changes, so it wasn't brought up to main`]);
    expect(existsSync(join(box.repo, "feature.txt"))).toBe(false);
  });

  test("a main checkout that went its own way isn't merged into", () => {
    const { dir, branch } = merged();
    commit(box.repo, "local.txt", "mine\n");
    const left: string[] = finish(dir, branch);
    expect(left).toHaveLength(1);
    expect(left[0]).toStartWith(`${box.repo} couldn't fast-forward to origin/main: `);
  });
});

describe("drop, unmerged", () => {
  const make = (name: string): [string, string] => box.lua(`${WT} return { wt.make(util.repo_root(vim.fn.getcwd()), input) }`, name);
  const drop = (dir: string, branch: string) => box.lua(`${WT} return wt.drop(input[1], input[2]) or vim.NIL`, [dir, branch]);

  test("nothing in it but what's elsewhere: removed with its branch", () => {
    box = sandbox();
    const [bare, bareBranch] = make("bare");
    const [pushed, pushedBranch] = make("pushed");
    commit(pushed, "p.txt", "p", pushedBranch);
    expect(drop(bare, bareBranch)).toBeNull();
    expect(drop(pushed, pushedBranch)).toBeNull();
    expect(existsSync(bare) || existsSync(pushed)).toBe(false);
    expect(branches()).toEqual(["main"]);
  });

  test("uncommitted changes, or commits only it has, keep it", () => {
    box = sandbox();
    const [dirty, dirtyBranch] = make("dirty");
    writeFileSync(join(dirty, "README.md"), "changed");
    const [ahead, aheadBranch] = make("ahead");
    commit(ahead, "a.txt", "a");
    expect(drop(dirty, dirtyBranch)).toBe(`${dirty} has uncommitted changes, so it's kept`);
    expect(drop(ahead, aheadBranch)).toBe(`${ahead} has commits on no other branch and not pushed, so it's kept`);
    expect(existsSync(dirty) && existsSync(ahead)).toBe(true);
    // On another branch, they're not only here.
    box.git(["branch", "copy", aheadBranch]);
    expect(drop(ahead, aheadBranch)).toBeNull();
    expect(existsSync(ahead)).toBe(false);
  });

  test("one that's gone already is nothing to do", () => {
    box = sandbox();
    expect(drop(join(box.dir, "nowhere"), "x")).toBeNull();
  });
});

describe("the node's MCP for a session in a worktree", () => {
  test("forge_repo: owner/repo of a forge origin, nothing for another", () => {
    box = sandbox();
    box.git(["remote", "set-url", "origin", "corkboard://forge/me/project.git"]);
    const forge = box.lua(`${WT} return wt.forge_repo(vim.fn.getcwd())`);
    // As it was written before (bridge/forge-git.ts), with a bridge's port.
    box.git(["remote", "set-url", "origin", "http://127.0.0.1:4000/forge/me/project.git"]);
    const legacy = box.lua(`${WT} return wt.forge_repo(vim.fn.getcwd())`);
    box.git(["remote", "set-url", "origin", "https://github.com/me/project.git"]);
    expect([forge, legacy, box.lua(`${WT} return wt.forge_repo(vim.fn.getcwd()) or vim.NIL`)]).toEqual(["me/project", "me/project", null]);
  });

  test("a config of its own, with the forge's tools told its branch and repo, only this user can read", () => {
    box = sandbox();
    box.git(["remote", "set-url", "origin", "http://127.0.0.1:4000/forge/me/project.git"]);
    const shared = join(box.dir, "mcp.json");
    const memory = { type: "http", url: "http://127.0.0.1:4000/mcp?tools=memory", headers: { Authorization: "Bearer t" } };
    writeFileSync(shared, JSON.stringify({ mcpServers: { "corkboard-memory": memory } }));
    const [path, main] = box.lua(
      `${WT}
      local dir = wt.make(util.repo_root(vim.fn.getcwd()), "s1")
      return { wt.mcp_config(dir), wt.mcp_config(vim.fn.getcwd()) }`,
      null,
      { env: { CORKBOARD_MEMORY_MCP_CONFIG: shared } },
    );
    expect(main).toBe(shared);
    expect(path).toBe(join(box.home, ".local/state/corkboard/session-mcp", `${box.repo.slice(1).replaceAll("/", "-")}--agent-s1-work.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({
      "corkboard-memory": memory,
      "corkboard-forge": {
        ...memory,
        url: "http://127.0.0.1:4000/mcp?tools=forge",
        headers: { Authorization: "Bearer t", "X-Corkboard-Branch": "agent/s1/work", "X-Corkboard-Repo": "me/project" },
      },
    });
  });
});
