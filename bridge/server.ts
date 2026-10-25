// Bridges a browser websocket to `nvim --embed`.
//
// Neovim speaks msgpack-RPC on stdio; the browser speaks the same messages
// as JSON over the socket. Neovim's ext types (Buffer, Window, Tabpage) cross
// as {__ext, id} so they survive the round trip.
//
// Whoever can reach this socket can run arbitrary code through Neovim, so it
// binds to loopback unless told otherwise, and then wants a token (see
// TOKEN). Either way the socket only opens for this bridge's own page.

import { decodeMultiStream, decode, encode, ExtensionCodec } from "@msgpack/msgpack";
import type { Subprocess } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as boards from "./boards";
import * as phone from "./phone";
import { CLOUD } from "./cloud";

const HOST = process.env.CORKBOARD_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CORKBOARD_PORT ?? 7777);
const NVIM = process.env.CORKBOARD_NVIM ?? "nvim";
// The page as `bun run build` writes it (web/dist).
const WEB_ROOT = new URL("../web/dist/", import.meta.url).pathname;
// `bun run dev` (--dev): build the page again each time it loads, so a
// reload shows the source as it is now.
const DEV = process.argv.includes("--dev");
const PLUGIN_ROOT = new URL("../nvim", import.meta.url).pathname;
// Third-party plugins (snacks.nvim) as a colon-separated list of plugin
// directories; the flake's dev shell sets it from nixpkgs.
const PLUGINS = (process.env.CORKBOARD_PLUGINS ?? "").split(":").filter(Boolean);
// The app's name in the web app manifest, so two bridges installed as apps
// (the installed one and the dev one) tell apart in launchers and
// notifications.
const NAME = process.env.CORKBOARD_NAME;

// Loopback names, for the bind address and for the Host a loopback bridge
// accepts. Browsers resolve *.localhost to loopback themselves, never by
// DNS, so names like dev.corkboard.localhost can't be rebound either.
const isLoopback = (name: string) =>
  /^((.+\.)?localhost|127(\.\d+){3}|::1)$/.test(name.replace(/^\[(.*)\]$/, "$1"));
const LOCAL = isLoopback(HOST);

// The token the page must send to open a socket: CORKBOARD_TOKEN, or the
// contents of CORKBOARD_TOKEN_FILE (made there on first start, so it stays
// the same across restarts). Bound beyond loopback with neither, the bridge
// makes one for this run. The page gets it in the URL printed at startup, in
// the fragment (#token=), which the browser never sends anywhere, and sends
// it as a websocket subprotocol, which keeps it out of URLs and logs.
function readToken(): string {
  if (process.env.CORKBOARD_TOKEN) return process.env.CORKBOARD_TOKEN;
  const file = process.env.CORKBOARD_TOKEN_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  if (!file && LOCAL) return "";
  const token = randomBytes(24).toString("hex");
  if (file) writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
const TOKEN = readToken();
// It goes in Sec-WebSocket-Protocol, which allows only these.
if (TOKEN && !/^[\w.~-]+$/.test(TOKEN)) throw new Error("CORKBOARD_TOKEN: use letters, digits and . _ ~ - only");
if (!LOCAL && !TOKEN) throw new Error(`refusing to bind ${HOST} without a token`);
const TOKEN_PROTOCOL = "corkboard.token.";

const sameToken = (given: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Why an upgrade is refused, if it is. Origin must be this bridge's own
// page, so another site open in the browser can't connect. A loopback
// bridge also wants a loopback Host, or a site whose name was rebound to
// 127.0.0.1 would be its own origin.
function refuse(req: Request): string | undefined {
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  if (LOCAL && !isLoopback(new URL(`http://${host}`).hostname)) return `wrong host: ${host}`;
  if (!origin || URL.parse(origin)?.host !== host) return `wrong origin: ${origin}`;
}

const extensionCodec = new ExtensionCodec();
for (const type of [0, 1, 2]) {
  extensionCodec.register({
    type,
    encode: (obj: any) => (obj?.__ext === type ? encode(obj.id) : null),
    decode: (data: Uint8Array) => ({ __ext: type, id: decode(data) }),
  });
}

// Machines a page can open a project on with ?host=<name>, as JSON, or the
// path of a JSON file (systemd's Environment= mangles inline quotes):
// { "<name>": { "target": "user@address", "options": [ssh args...] } }.
// Their Neovim is CORKBOARD_REMOTE_NVIM, a store path (a wrapper that puts
// this plugin and its company on the runtimepath) that nix copy delivers
// first, so the far side needs Nix and a login, not an install.
type Remote = { target: string; options?: string[] };
const remotesRaw = process.env.CORKBOARD_REMOTES ?? "{}";
const REMOTES: Record<string, Remote> = JSON.parse(
  remotesRaw.startsWith("/") ? readFileSync(remotesRaw, "utf8") : remotesRaw,
);
const REMOTE_NVIM = process.env.CORKBOARD_REMOTE_NVIM;

type Session = {
  nvim?: Subprocess<"pipe", "pipe", "pipe">;
  cwd: string;
  host?: string;
  error?: string;
  // What the page sent while a remote Neovim was still being started.
  queued?: string[];
  closed?: boolean;
  lastError?: string;
  // Neovim's cloud boards, made when it first asks for one (boards.ts).
  cloud?: boards.Session;
  // "plan": the day plan's window (?view=plan), of which there's one.
  view?: "plan";
};

// The project Neovim last opened (remember_project in corkboard/init.lua).
const LAST_PROJECT = resolve(process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state"), "corkboard/last-project");

function lastProject(): string | null {
  try {
    const dir = readFileSync(LAST_PROJECT, "utf8").trim();
    return dir && statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

// ?cwd= from the page: "~" expands, relative paths are from home. Without
// one, the last project opened, or home if there is none. A missing
// directory has to be caught here, because posix_spawn reports a bad cwd as
// ENOENT on the executable ("posix_spawn 'nvim'").
function resolveCwd(raw: string | null): { cwd: string; error?: string } {
  const home = homedir();
  const cwd = resolve(home, (raw ?? lastProject() ?? home).replace(/^~(?=$|\/)/, home));
  try {
    if (statSync(cwd).isDirectory()) return { cwd };
  } catch {}
  return { cwd, error: `no such directory: ${cwd}` };
}

// A page's ?host=, checked against REMOTES. The cwd is the far side's to
// resolve ("~" included); with none, it is wherever that machine's login
// leaves you.
function resolveRemote(host: string, raw: string | null): Session {
  if (!REMOTES[host]) return { cwd: "", host, error: `unknown host: ${host}` };
  if (!REMOTE_NVIM) return { cwd: "", host, error: "CORKBOARD_REMOTE_NVIM is not set" };
  return { cwd: raw ?? "", host, queued: [] };
}

// One word for a POSIX shell.
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Run on the remote by sshd's shell. The login profile is sourced by hand
// rather than with bash -l, with its output sent to stderr: whatever a
// profile prints would otherwise land in Neovim's msgpack stream. It is
// sourced at all because that is where a machine keeps the environment its
// tools need (brain-vm's credentials), and Neovim's terminals inherit it.
const REMOTE_SCRIPT = `
exec 3>&1 1>&2
[ -r /etc/profile ] && . /etc/profile
[ -r "$HOME/.profile" ] && . "$HOME/.profile"
if [ -n "$1" ]; then
  case "$1" in "~") d=$HOME ;; "~/"*) d=$HOME/\${1#"~/"} ;; *) d=$1 ;; esac
  cd -- "$d" || { echo "no such directory: $1" >&2; exit 1; }
fi
exec "$2" --embed 1>&3 3>&-
`;

async function spawnRemote(data: Session): Promise<NonNullable<Session["nvim"]>> {
  const remote = REMOTES[data.host!];
  const options = remote.options ?? [];
  // A no-op once the store path is there, which is every time but the first
  // after a rebuild. --no-check-sigs because the plugin and theme are built
  // here and signed by nobody; the far side accepts that only from a user
  // it trusts, which is the one requirement on it.
  const copy = Bun.spawn(["nix", "copy", "--no-check-sigs", "--to", `ssh-ng://${remote.target}`, REMOTE_NVIM!], {
    env: { ...process.env, NIX_SSHOPTS: options.join(" ") },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await copy.exited) !== 0) {
    const err = (await new Response(copy.stderr).text()).trim().split("\n").at(-1);
    throw new Error(`nix copy to ${data.host} failed: ${err}`);
  }
  const command = `bash -c ${sh(REMOTE_SCRIPT)} corkboard ${sh(data.cwd)} ${sh(REMOTE_NVIM!)}`;
  return Bun.spawn(["ssh", ...options, "-T", remote.target, "--", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function spawnLocal(data: Session): NonNullable<Session["nvim"]> {
  const rtp = `set rtp^=${[PLUGIN_ROOT, ...PLUGINS].map((p) => p.replace(/[ \\,]/g, "\\$&")).join(",")}`;
  return Bun.spawn([NVIM, "--embed", "--cmd", rtp], {
    cwd: data.cwd,
    // corkboard.window: which window this Neovim is for. CORKBOARD_CLOUD:
    // the Worker, for what Neovim starts itself (the plan's Claude Code).
    env: { ...process.env, CORKBOARD_CLOUD: CLOUD, ...(data.view ? { CORKBOARD_WINDOW: data.view } : {}) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function toNvim(nvim: NonNullable<Session["nvim"]>, raw: string) {
  send(nvim, JSON.parse(raw));
}

function send(nvim: NonNullable<Session["nvim"]>, msg: unknown) {
  nvim.stdin.write(encode(msg, { extensionCodec }));
  nvim.stdin.flush();
}

// Neovim's "corkboard.cloud" notifications are for the bridge, not the
// page: answered here (boards.ts).
const CLOUD_METHOD = "corkboard.cloud";

function cloud(data: Session, nvim: NonNullable<Session["nvim"]>, params: any[]) {
  const lua = (code: string, ...args: unknown[]) => {
    if (!data.closed) send(nvim, [2, "nvim_exec_lua", [code, args]]);
  };
  data.cloud ??= new boards.Session((key, event) =>
    key === boards.USER
      ? lua("require('corkboard.plan').cloud_event(...)", event)
      : lua("require('corkboard.cards').cloud_event(...)", key, event),
  );
  const [id, op, ...args] = params;
  const answer = (a: object) => lua("require('corkboard.cards.cloud').answer(...)", { id, ...a });
  data.cloud.call(op, args).then(
    (result) => answer({ result: result ?? null }),
    (err) => answer({ error: (err as Error).message }),
  );
}

// Close reasons are capped at 123 bytes by the websocket spec.
const closeReason = (s: string) => new TextEncoder().encode(s).length > 120 ? s.slice(0, 100) + "…" : s;

async function pump(ws: Bun.ServerWebSocket<Session>, nvim: NonNullable<Session["nvim"]>) {
  try {
    for await (const msg of decodeMultiStream(nvim.stdout, { extensionCodec })) {
      if (Array.isArray(msg) && msg[0] === 2 && msg[1] === CLOUD_METHOD) cloud(ws.data, nvim, msg[2] as any[]);
      else ws.send(JSON.stringify(msg));
    }
  } catch (err) {
    console.error("nvim stream:", err);
  }
  // A remote that never got as far as Neovim (a missing directory, a
  // refused login) says why on stderr; the page shows the close reason.
  const why = ws.data.nvim && !(await ws.data.nvim.exited) ? "" : ws.data.lastError;
  ws.close(1000, closeReason(why ? `nvim exited: ${why}` : "nvim exited"));
}

function start(ws: Bun.ServerWebSocket<Session>, nvim: NonNullable<Session["nvim"]>) {
  ws.data.nvim = nvim;
  pump(ws, nvim);
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of nvim.stderr) {
      process.stderr.write(chunk);
      const line = decoder.decode(chunk).trim().split("\n").at(-1);
      if (line) ws.data.lastError = line;
    }
  })();
  for (const raw of ws.data.queued ?? []) toNvim(nvim, raw);
  ws.data.queued = undefined;
}

// The build under way, which loads at the same time (the day plan's window
// and a project's) share, and which the page's assets wait for, since the
// build empties dist/ first. Its error output, if it failed.
let building: Promise<string | undefined> | undefined;

function build() {
  building ??= (async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 0) return undefined;
    console.error(`page build failed:\n${err}`);
    return out + err;
  })().finally(() => (building = undefined));
  return building;
}

// The day plan's window, while one is open.
let planWindow: Bun.ServerWebSocket<Session> | undefined;
// Every page's socket, for the reload below.
const pages = new Set<Bun.ServerWebSocket<Session>>();

// In dev, a new commit reloads every page: the build, Neovim and its plugin
// as committed, rather than each save half way through a change. A reload
// starts the page's Neovim again, terminals and all.
async function head() {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : undefined;
}
if (DEV) {
  let last = await head();
  setInterval(async () => {
    const now = await head();
    if (!now || now === last) return;
    last = now;
    console.log(`commit ${now.slice(0, 7)}: reloading ${pages.size} page(s)`);
    for (const ws of pages) ws.send(JSON.stringify([2, "corkboard.reload", []]));
  }, 2000);
}

Bun.serve<Session, {}>({
  hostname: HOST,
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/nvim") {
      const host = url.searchParams.get("host");
      const cwd = url.searchParams.get("cwd");
      const why = refuse(req);
      if (why) {
        console.error(`refused /nvim: ${why}`);
        return new Response(why, { status: 403 });
      }
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
      const token = offered.find((p) => p.startsWith(TOKEN_PROTOCOL))?.slice(TOKEN_PROTOCOL.length);
      // A wrong token still upgrades, to be closed with the reason before
      // Neovim starts, which the page can show; a refused upgrade it can't.
      // The day plan isn't a project's, so its window opens in the home
      // directory, on this machine.
      const view = url.searchParams.get("view") === "plan" ? "plan" : undefined;
      const data: Session =
        TOKEN && !(token && sameToken(token))
          ? { cwd: "", error: "wrong or missing token: open the URL the bridge printed" }
          : view
            ? { ...resolveCwd(homedir()), view }
            : host
              ? resolveRemote(host, cwd)
              : resolveCwd(cwd);
      // The browser drops a socket whose reply names no protocol it offered.
      const headers = offered.includes("corkboard") ? { "sec-websocket-protocol": "corkboard" } : undefined;
      return server.upgrade(req, { data, headers }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (path.split("/").includes("..")) return new Response("no", { status: 400 });
    if (DEV) {
      const failed = await (path === "index.html" ? build() : building);
      if (failed) return new Response(failed, { status: 500, headers: { "content-type": "text/plain" } });
    }
    const file = Bun.file(WEB_ROOT + path);
    if (path === "manifest.webmanifest" && NAME) {
      const manifest = { ...(await file.json()), name: NAME, short_name: NAME };
      return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json" } });
    }
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (ws.data.error) return ws.close(4000, closeReason(ws.data.error));
      pages.add(ws);
      // One day plan at a time: a new plan window takes over from the old.
      if (ws.data.view === "plan") {
        planWindow?.close(4002, "the day plan opened in another window");
        planWindow = ws;
      }
      if (ws.data.host) {
        spawnRemote(ws.data).then(
          (nvim) => (ws.data.closed ? nvim.kill() : start(ws, nvim)),
          (err) => {
            console.error(`remote ${ws.data.host}:`, err);
            ws.close(4001, closeReason(err.message));
          },
        );
        return;
      }
      try {
        start(ws, spawnLocal(ws.data));
      } catch (err: any) {
        console.error("spawn nvim:", err);
        ws.close(4001, closeReason(`could not start ${NVIM}: ${err.message}`));
      }
    },

    message(ws, raw) {
      if (ws.data.nvim) toNvim(ws.data.nvim, String(raw));
      else ws.data.queued?.push(String(raw));
    },

    close(ws) {
      if (planWindow === ws) planWindow = undefined;
      pages.delete(ws);
      ws.data.closed = true;
      ws.data.cloud?.close();
      ws.data.nvim?.kill();
    },
  },
});

console.log(`corkboard on http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/${TOKEN ? `#token=${TOKEN}` : ""}`);

// What the phone needs from this machine (phone.ts).
phone.start();
