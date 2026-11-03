// A compiled bridge (scripts/build-bridge.ts), tried: started on a spare
// port with state of its own, its page fetched, a socket opened as the page
// opens one, its Neovim asked whether the plugin loaded, and its MCP server
// asked for its tools; and its git, as the app runs it for a machine with
// none, made to commit and to reach GitHub. For CI, on each OS.
//
//   bun scripts/smoke-bridge.ts [<os>-<arch>]     this machine's by default

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledGit } from "../app/bridge.js";

const OS = { linux: "linux", darwin: "mac", win32: "win" } as Record<string, string>;
const target = process.argv[2] ?? `${OS[process.platform]}-${process.arch}`;
const dir = join(import.meta.dir, "..", "dist", "bridge", target);
const exe = join(dir, process.platform === "win32" ? "corkboard-bridge.exe" : "corkboard-bridge");
const nvim = join(dir, "nvim", "bin", process.platform === "win32" ? "nvim.exe" : "nvim");
const home = mkdtempSync(join(tmpdir(), "corkboard-smoke-"));
const port = 7000 + Math.floor(Math.random() * 900);
const token = "smoke" + Math.random().toString(36).slice(2);
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  CORKBOARD_PORT: String(port),
  CORKBOARD_TOKEN: token,
  CORKBOARD_NVIM: nvim,
  CORKBOARD_REMOTE_SESSIONS: "0",
};

const fail = (why: string): never => {
  console.error(`smoke: ${why}`);
  bridge.kill();
  process.exit(1);
};

const bridge = Bun.spawn([exe], { cwd: home, env, stdout: "inherit", stderr: "inherit" });
const url = `http://127.0.0.1:${port}/`;
let page: Response | undefined;
for (let i = 0; i < 100 && !page; i++) {
  await Bun.sleep(100);
  page = await fetch(url).catch(() => undefined);
}
if (!page?.ok || !(await page.text()).includes("<title>corkboard")) fail(`no page at ${url}`);
console.log("page ok");

// --embed starts up only once a UI attaches; then Enter past any message
// (the sign-in one) before asking.
const answer = await new Promise<unknown>((done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/nvim`, {
    protocols: ["corkboard", `corkboard.token.${token}`],
    headers: { Origin: `http://127.0.0.1:${port}` },
  } as any);
  const timer = setTimeout(() => fail("no answer from Neovim"), 30_000);
  ws.onopen = () => {
    ws.send(JSON.stringify([0, 0, "nvim_ui_attach", [80, 24, { ext_linegrid: true }]]));
    setTimeout(() => ws.send(JSON.stringify([0, 0, "nvim_input", ["<CR><CR>"]])), 2000);
    setTimeout(() => ws.send(JSON.stringify([0, 1, "nvim_eval", ['[exists("g:loaded_corkboard"), $CORKBOARD_MCP_COMMAND]']])), 3000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg[0] !== 1 || msg[1] !== 1) return;
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
    done(msg[2] ? fail(`Neovim: ${JSON.stringify(msg[2])}`) : msg[3]);
  };
  ws.onclose = (e) => fail(`socket closed: ${e.code} ${e.reason}`);
});
const [loaded, mcp] = answer as [number, string];
if (loaded !== 1) fail("the plugin didn't load");
console.log("nvim ok");

const proc = Bun.spawn(JSON.parse(mcp), { cwd: home, env: { ...env, CORKBOARD_BOARD: join(home, "board") }, stdin: "pipe", stdout: "pipe" });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
proc.stdin.end();
const out = await new Response(proc.stdout).text();
if (!out.includes('"list_cards"')) fail(`no tools from the MCP server: ${out.slice(0, 200)}`);
console.log("mcp ok");

// With no git on the PATH it's given, the app takes its own.
const git = existsSync(join(dir, "git")) && bundledGit(dir, "");
if (git) {
  const genv = { ...env, ...git, PATH: [git.PATH, process.env.PATH].join("") };
  const gitExe = Bun.which("git", { PATH: genv.PATH });
  if (!gitExe?.startsWith(dir)) fail(`git is ${gitExe}, not the bundled one`);
  const run = (...args: string[]) => {
    const got = Bun.spawnSync([gitExe!, ...args], { cwd: home, env: genv });
    if (!got.success) fail(`git ${args.join(" ")}: ${got.stderr.toString().trim()}`);
    return got.stdout.toString().trim();
  };
  console.log(run("--version"));
  run("init", "-q", "repo");
  run("-C", "repo", "-c", "user.name=smoke", "-c", "user.email=smoke@corkboard", "commit", "-q", "--allow-empty", "-m", "smoke");
  if (!run("ls-remote", "https://github.com/desktop/dugite-native", "HEAD")) fail("git reached nothing over https");
  console.log("git ok");
}

bridge.kill();
await bridge.exited;
rmSync(home, { recursive: true, force: true });
