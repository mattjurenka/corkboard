// The packaged app's own bridge: the compiled one electron-builder put in
// resources/bridge (scripts/build-bridge.ts), with the Neovim beside it, on
// a loopback port of this app's and a token of this run's. It goes when the
// app does.
//
// The port is kept (bridge.json in the profile) so the page's origin, and
// with it what the page keeps in its storage, is the same from one run to
// the next; another is found only when something else has it.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const WIN = process.platform === "win32";
const exe = (name) => (WIN ? `${name}.exe` : name);
// One for the run, so a bridge started again takes the pages already open.
const token = randomBytes(24).toString("hex");

// A GUI app on macOS (and from some Linux launchers) gets a bare PATH, not
// the one the login shell makes, where claude and git usually are. That
// one, then, with the places their installers put them.
export function loginPath() {
  const extra = [join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  let path = process.env.PATH ?? "";
  if (!WIN) {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const got = spawnSync(shell, ["-ilc", 'printf "\\n__PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    const found = got.stdout?.split("__PATH__")[1]?.trim();
    if (found) path = found;
  }
  const have = new Set(path.split(delimiter));
  return [path, ...extra.filter((d) => !have.has(d) && existsSync(d))].filter(Boolean).join(delimiter);
}

// Where name is on path, if it is.
export function which(name, path) {
  const exts = WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    for (const ext of exts) if (dir && existsSync(join(dir, name + ext))) return join(dir, name + ext);
  }
}

const free = (port) =>
  new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(undefined));
    s.listen(port, "127.0.0.1", () => {
      const { port: got } = s.address();
      s.close(() => done(got));
    });
  });

async function pickPort(file) {
  let kept;
  try {
    kept = JSON.parse(readFileSync(file, "utf8")).port;
  } catch {}
  const port = (kept && (await free(kept))) || (await free(0));
  if (port !== kept) writeFileSync(file, JSON.stringify({ port }) + "\n");
  return port;
}

// Starts it and resolves to its page's URL once it answers. onExit(code)
// if it stops on its own.
export async function startBridge({ resources, profile, path, onExit }) {
  const dir = join(resources, "bridge");
  mkdirSync(profile, { recursive: true });
  const port = await pickPort(join(profile, "bridge.json"));
  const log = createWriteStream(join(profile, "bridge.log"), { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} port ${port}\n`);
  const proc = spawn(join(dir, exe("corkboard-bridge")), [], {
    cwd: homedir(),
    env: {
      ...process.env,
      PATH: path,
      CORKBOARD_HOST: "127.0.0.1",
      CORKBOARD_PORT: String(port),
      CORKBOARD_TOKEN: token,
      CORKBOARD_PARENT_PID: String(process.pid),
      CORKBOARD_NVIM: join(dir, "nvim", "bin", exe("nvim")),
      // The phone's calendar writing needs dayplan, which an install hasn't (phone.ts).
      CORKBOARD_PHONE: process.env.CORKBOARD_PHONE ?? "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  let stopping = false;
  proc.on("exit", (code) => !stopping && onExit?.(code));
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error(`the bridge exited (${proc.exitCode}); see ${join(profile, "bridge.log")}`);
    try {
      if ((await fetch(url, { method: "HEAD" })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    home: `${url}#token=${token}`,
    stop() {
      stopping = true;
      proc.kill();
    },
  };
}
