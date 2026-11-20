// The plugin's Lua in a real Neovim, for the tests beside it: a sandbox is a
// home of its own (HOME, XDG_*, Claude Code's config dir), a git repository
// with a bare origin, and a bin/ first on PATH for stand-ins (a claude that
// answers from a file). Each lua() is a fresh `nvim --headless --clean -l`
// in the repository with the plugin on the runtimepath; what the code
// returns comes back as JSON.
//
// Nothing the user runs is reached: no corkboard, NVIM, CLAUDE or GIT
// variable of the test's own environment gets through, so there is no
// bridge (cards are the files, CORKBOARD_CLOUD_BOARDS=0), no parent Neovim
// and no global git config.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Dict, dict } from "../lib/dict";

export const PLUGIN = import.meta.dir;

export type Sandbox = {
  dir: string;
  home: string;
  repo: string;
  origin: string;
  // What origin is to git: origin's path, or the forge's URL for it.
  remote: string;
  bin: string;
  env: Dict<string>;
  // The code is a Lua function's body, given `input`; it may vim.wait.
  lua<T = any>(code: string, input?: unknown, opts?: { cwd?: string; env?: Record<string, string> }): T;
  git(args: string[], cwd?: string): string;
  write(path: string, text: string): string;
  read(path: string): string;
  // An executable in bin/: a shell script's body.
  stub(name: string, body: string): void;
  // The board's directory, as cards.dir() finds it for the repository.
  board: string;
  cleanup(): void;
};

const RUNNER = String.raw`
vim.opt.rtp:prepend(os.getenv("CORKBOARD_TEST_PLUGIN"))
local f = assert(io.open(os.getenv("CORKBOARD_TEST_INPUT")))
local input = vim.json.decode(f:read("a"), { luanil = { object = true, array = true } })
f:close()
local body = assert(loadfile(os.getenv("CORKBOARD_TEST_CODE")))
local ok, result = xpcall(body, debug.traceback, input)
local out = assert(io.open(os.getenv("CORKBOARD_TEST_RESULT"), "w"))
local encoded, err = pcall(vim.json.encode, ok and { result = result == nil and vim.NIL or result } or { error = result })
out:write(encoded and err or vim.json.encode({ error = "the result isn't JSON: " .. tostring(err) }))
out:close()
`;

let runs = 0;

// opts.forge: origin is served over HTTP as the node's forge is
// (http://127.0.0.1:<port>/forge/me/project.git, nvim/forge-server.ts).
export function sandbox(opts: { repo?: boolean; forge?: boolean } = {}): Sandbox {
  // Real paths: git and Neovim give them, and the tests compare.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corkboard-nvim-")));
  const home = join(dir, "home");
  const repo = join(dir, "project");
  const origin = opts.forge ? join(dir, "forge/me/project.git") : join(dir, "origin.git");
  const bin = join(dir, "bin");
  for (const d of [home, bin, join(home, ".config"), join(home, ".local/share"), join(home, ".local/state"), join(home, ".claude")]) {
    mkdirSync(d, { recursive: true });
  }
  const gitconfig = join(home, ".gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  const env = dict<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CORKBOARD|NVIM|CLAUDE|GIT|XDG)_?/.test(k)) env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CORKBOARD_CLOUD_BOARDS: "0",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    CORKBOARD_TEST_PLUGIN: PLUGIN,
  });

  const git = (args: string[], cwd = repo) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const write = (path: string, text: string) => {
    const p = path.startsWith("/") ? path : join(repo, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };

  // The agents' commands, as ones that do nothing: what the plugin would
  // start is never the real one on the machine. A test stubs its own.
  for (const name of ["claude", "codex-acp", "opencode", "agy"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }

  let server: ReturnType<typeof Bun.spawn> | undefined;
  let remote = origin;
  if (opts.repo !== false) {
    mkdirSync(repo);
    git(["init", "--quiet", "--bare", origin], dir);
    if (opts.forge) {
      const portFile = join(dir, "forge.port");
      server = Bun.spawn(["bun", join(PLUGIN, "forge-server.ts"), join(dir, "forge"), portFile], { env, stdout: "ignore", stderr: "inherit" });
      for (let i = 0; i < 500 && !existsSync(portFile); i++) Bun.sleepSync(10);
      remote = `http://127.0.0.1:${readFileSync(portFile, "utf8")}/forge/me/project.git`;
    }
    git(["init", "--quiet"]);
    write("README.md", "hello\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "first"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "--quiet", "-u", "origin", "main"]);
  } else {
    mkdirSync(repo);
  }

  const lua = (code: string, input: unknown = null, o: { cwd?: string; env?: Record<string, string> } = {}) => {
    const n = ++runs;
    const files = { code: join(dir, `run${n}.lua`), input: join(dir, `run${n}.json`), result: join(dir, `run${n}.out`), runner: join(dir, "runner.lua") };
    writeFileSync(files.runner, RUNNER);
    writeFileSync(files.code, `local input = ...\n${code}`);
    writeFileSync(files.input, JSON.stringify(input));
    const r = Bun.spawnSync(["nvim", "--headless", "--clean", "-l", files.runner], {
      cwd: o.cwd ?? repo,
      env: { ...env, ...o.env, CORKBOARD_TEST_CODE: files.code, CORKBOARD_TEST_INPUT: files.input, CORKBOARD_TEST_RESULT: files.result },
      stdin: "ignore",
    });
    let out: { result?: any; error?: string };
    try {
      out = JSON.parse(readFileSync(files.result, "utf8"));
    } catch {
      throw new Error(`nvim exited ${r.exitCode} with no result: ${r.stderr.toString()}`);
    }
    if (out.error !== undefined) throw new Error(out.error);
    return out.result;
  };

  return {
    dir,
    home,
    repo,
    origin,
    remote,
    bin,
    env,
    lua,
    git,
    write,
    read: (path) => readFileSync(path.startsWith("/") ? path : join(repo, path), "utf8"),
    stub(name, body) {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    },
    board: join(home, ".local/share/corkboard/boards", repo.replace(/^\//, "").replaceAll("/", "-")),
    cleanup: () => {
      server?.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
