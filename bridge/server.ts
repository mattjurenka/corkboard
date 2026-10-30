// Bridges a browser websocket to `nvim --embed`; or, with ?wasm, to the
// Neovim the page runs itself (wasm.ts), for which this is the machine.
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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as away from "./away";
import * as boards from "./boards";
import * as phone from "./phone";
import * as remote from "./remote";
import * as wasm from "./wasm";
import { CLOUD, token } from "./cloud";

const HOST = process.env.CORKBOARD_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CORKBOARD_PORT ?? 7777);
const NVIM = process.env.CORKBOARD_NVIM ?? "nvim";
// Neovim compiled to wasm (the nvim-wasm package, wasm/: nvim.js, .wasm,
// .data), for pages opened with ?wasm. Served at /wasm/<version>/, which
// changes when it does, so the browser keeps its 28 MB for good.
const NVIM_WASM = process.env.CORKBOARD_NVIM_WASM;
const WASM_VERSION = NVIM_WASM && createHash("sha256").update(realpathSync(NVIM_WASM)).digest("hex").slice(0, 16);
// CORKBOARD_WASM=1: every page runs its Neovim itself unless it asks not to
// (?wasm=0): the bridge only its machine. For a bridge far from its pages
// (the droplet's workspace), whose Neovim is then near the person using it.
const WASM_DEFAULT = !!NVIM_WASM && process.env.CORKBOARD_WASM === "1";
// Whether a page's URL has it run Neovim itself.
const inPage = (url: URL) => (url.searchParams.has("wasm") ? url.searchParams.get("wasm") !== "0" : false);
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
// Behind a proxy (Caddy on the droplet), the page's origin is the proxy's
// public one, e.g. https://valheim.jurenka.software:8443: the socket opens
// for that origin only, whatever Host the proxy sends, and wants a token.
const ORIGIN = process.env.CORKBOARD_ORIGIN;

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
  if (!file && LOCAL && !ORIGIN) return "";
  const token = randomBytes(24).toString("hex");
  if (file) writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
const TOKEN = readToken();
// It goes in Sec-WebSocket-Protocol, which allows only these.
if (TOKEN && !/^[\w.~-]+$/.test(TOKEN)) throw new Error("CORKBOARD_TOKEN: use letters, digits and . _ ~ - only");
if ((!LOCAL || ORIGIN) && !TOKEN) throw new Error(`refusing to bind ${HOST} without a token`);
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
  if (ORIGIN) return origin === ORIGIN ? undefined : `wrong origin: ${origin}`;
  if (LOCAL && !isLoopback(new URL(`http://${host}`).hostname)) return `wrong host: ${host}`;
  if (!origin || URL.parse(origin)?.host !== host) return `wrong origin: ${origin}`;
}

// The same for a request the page may make as a plain GET, which a browser
// sends with no Origin when it's same-origin: then its Sec-Fetch-Site says.
function refuseFetch(req: Request): string | undefined {
  if (req.headers.has("origin")) return refuse(req);
  const host = req.headers.get("host") ?? "";
  if (LOCAL && !isLoopback(new URL(`http://${host}`).hostname)) return `wrong host: ${host}`;
  if (req.headers.get("sec-fetch-site") !== "same-origin") return `not from this page: ${req.headers.get("sec-fetch-site")}`;
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
  // What away mode knows it by (away.ts).
  page?: away.Page;
  // Its Neovim's project (its global cwd), as it last said.
  project?: string;
  // ?wasm: Neovim is the page's, and this its machine.
  wasm?: boolean;
  wasmHost?: wasm.Host;
  // How to reach the page's Neovim, when it is the page's.
  toPage?: (msg: unknown) => void;
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

// The portal's way in (cloud/src/portal.ts): a ticket the Worker made for
// one board on this bridge, redeemed there as this bridge, for where the
// board's clone is here, or else the remotes to clone it from into ~/src.
// Then the page, with this bridge's token, at that project.
const plain = (status: number, text: string) => new Response(text + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const cloning = new Map<string, Promise<string | undefined>>();

async function open(ticket: string): Promise<Response> {
  const bridge = remote.self();
  if (!bridge) return plain(503, "this bridge isn't following the Worker (CORKBOARD_REMOTE_SESSIONS=0)");
  let res: Response;
  try {
    res = await fetch(`${CLOUD}/api/workspace/redeem`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bridge, ticket }),
    });
  } catch (err: any) {
    return plain(503, `couldn't reach ${CLOUD}: ${err.message}`);
  }
  const board = (await res.json().catch(() => ({}))) as { error?: string; key: string; name: string; root: string | null; remotes: string[] };
  if (!res.ok) return plain(res.status, board.error ?? `HTTP ${res.status}`);
  let cwd = board.root && isDir(board.root) ? board.root : undefined;
  if (!cwd) {
    cwd = join(homedir(), "src", (board.name || board.key).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || board.key);
    if (!isDir(join(cwd, ".git"))) {
      if (!cloning.has(cwd)) cloning.set(cwd, clone(board.remotes, cwd, board.key).finally(() => cloning.delete(cwd!)));
      const failed = await cloning.get(cwd);
      if (failed) return plain(502, failed);
    }
  }
  return new Response(null, { status: 302, headers: { Location: `/?cwd=${encodeURIComponent(cwd)}${TOKEN ? `#token=${TOKEN}` : ""}` } });
}

// Each remote in turn, a GitHub one over https first (gh's credentials),
// until one clones. What went wrong, if none did. The clone is pinned to the
// board (util.lua's pinned_board): one added in the portal has no first commit
// to be found by until a clone of it is opened.
async function clone(remotes: string[], dest: string, board: string): Promise<string | undefined> {
  const urls = remotes.flatMap((u) => {
    const scp = u.match(/^git@github\.com:(.+)$/);
    return scp ? [`https://github.com/${scp[1]}`, u] : [u];
  });
  if (!urls.length) return "that board has no remotes to clone it from";
  const errors: string[] = [];
  for (const url of urls) {
    const proc = Bun.spawn(["git", "clone", "--quiet", url, dest], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
    });
    const timer = setTimeout(() => proc.kill(), 5 * 60_000);
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timer));
    if (code === 0) {
      await Bun.spawn(["git", "-C", dest, "config", "corkboard.board", board], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
      return;
    }
    errors.push(`${url}: ${err.trim() || `exit ${code}`}`);
  }
  return `couldn't clone it:\n${errors.join("\n")}`;
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

// To a session's Neovim: here on stdin, or in the page by way of its socket.
// [9, msg] is the page's to hand on to its Neovim.
function deliver(data: Session, msg: unknown) {
  if (data.closed) return;
  if (data.toPage) data.toPage([9, msg]);
  else if (data.nvim) send(data.nvim, msg);
}

// Bytes in JSON, for the page to turn back into bytes ([9, ...] messages).
// The value as it was, before a Buffer's toJSON had it.
function toJson(this: any, key: string, value: unknown) {
  const raw = this[key];
  return raw instanceof Uint8Array ? { $b: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") } : value;
}

// Neovim's "corkboard.cloud" notifications are for the bridge, not the
// page: answered here (boards.ts).
const CLOUD_METHOD = "corkboard.cloud";

function cloud(data: Session, params: any[]) {
  const lua = (code: string, ...args: unknown[]) => deliver(data, [2, "nvim_exec_lua", [code, args]]);
  data.cloud ??= new boards.Session((key, event) =>
    key === boards.USER
      ? // The day plan's window follows it for the plan, a project's for the fleet view.
        lua("require(require('corkboard').window == 'plan' and 'corkboard.plan' or 'corkboard.fleet').cloud_event(...)", event)
      : lua("require('corkboard.cards').cloud_event(...)", key, event),
    () => away.list(data.page),
  );
  const [id, op, ...args] = params;
  const answer = (a: object) => lua("require('corkboard.cards.cloud').answer(...)", { id, ...a });
  data.cloud.call(op, args).then(
    (result) => answer({ result: result ?? null }),
    (err) => answer({ error: (err as Error).message }),
  );
}

// "corkboard.away", from Neovim or the page, is for the bridge too: away
// mode spans every page (away.ts). Neovim reports its sessions and enters
// it; the page stays away or leaves.
const AWAY_METHOD = "corkboard.away";

function awayFrom(data: Session, [op, ...args]: any[]) {
  if (!data.page) return;
  if (op === "report") away.report(data.page, args[0] ?? []);
  else if (op === "enter") away.enter(data.page);
  else away.command(data.page, op, args);
}

// Close reasons are capped at 123 bytes by the websocket spec.
const closeReason = (s: string) => new TextEncoder().encode(s).length > 120 ? s.slice(0, 100) + "…" : s;

// What Neovim tells the bridge rather than the page: true when that's all
// msg was. The page's own Neovim's come by way of the page.
function fromNvim(ws: Bun.ServerWebSocket<Session>, msg: unknown): boolean {
  if (!Array.isArray(msg) || msg[0] !== 2) return false;
  const params = msg[2] as any[];
  if (msg[1] === CLOUD_METHOD) cloud(ws.data, params);
  else if (msg[1] === AWAY_METHOD) awayFrom(ws.data, params);
  else if (msg[1] === OPEN_METHOD) {
    const [{ cwd, run }] = params as [{ cwd: string; run?: Run }];
    openWindow(ws, cwd, run);
  } else {
    if (msg[1] === "corkboard.context") arrived(ws, params[0]);
    return false;
  }
  return true;
}

async function pump(ws: Bun.ServerWebSocket<Session>, nvim: NonNullable<Session["nvim"]>) {
  try {
    for await (const msg of decodeMultiStream(nvim.stdout, { extensionCodec })) {
      if (!fromNvim(ws, msg)) ws.send(JSON.stringify(msg));
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

// One window per project on each machine. A project asked for again (Neovim's
// corkboard.open: the projects picker, the day plan, the fleet view; the
// page's corkboard.window: Open project) brings its window forward rather
// than opening another; one with no window yet opens in a new one from the
// window that asked (corkboard.open in main.tsx). run, from Neovim, is what
// to do there once it's up: [module, function, ...args], which handoff in
// corkboard/init.lua calls.
const OPEN_METHOD = "corkboard.open";
const WINDOW_METHOD = "corkboard.window";
type Run = [string, string, ...unknown[]];
// What to run in the windows asked for, when each says it's there.
const opening = new Map<string, { at: number; runs: Run[] }>();
const OPENING_MS = 60 * 1000;

const trimSlash = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);
const windowKey = (host: string | undefined, project: string) => `${host ?? ""}\0${project}`;
const notifyPage = (ws: Bun.ServerWebSocket<Session>, method: string, ...params: unknown[]) =>
  ws.send(JSON.stringify([2, method, params]));
const handoff = (ws: Bun.ServerWebSocket<Session>, run: Run) => ws.data.page?.exec("require('corkboard').handoff(...)", ...run);

function windowOf(host: string | undefined, project: string) {
  for (const ws of pages) if (!ws.data.view && ws.data.host === host && ws.data.project === project) return ws;
}

function openWindow(from: Bun.ServerWebSocket<Session>, cwd: string, run?: Run) {
  const project = trimSlash(cwd);
  const there = windowOf(from.data.host, project);
  if (there) {
    if (run) handoff(there, run);
    if (there !== from) notifyPage(there, "corkboard.front");
    return;
  }
  const key = windowKey(from.data.host, project);
  const was = opening.get(key);
  const runs = was && Date.now() - was.at < OPENING_MS ? was.runs : [];
  opening.set(key, { at: Date.now(), runs: run ? [...runs, run] : runs });
  notifyPage(from, OPEN_METHOD, { cwd: project });
}

// Each page, the projects with a window on its machine, for Open project.
function tellWindows() {
  for (const ws of pages) {
    const projects = [...pages].filter((o) => !o.data.view && o.data.project && o.data.host === ws.data.host).map((o) => o.data.project);
    notifyPage(ws, "corkboard.windows", projects);
  }
}

// A window's project, as its Neovim says it (corkboard.context). One just
// opened for it gets what it was opened to do.
function arrived(ws: Bun.ServerWebSocket<Session>, context: { cwd?: string; project?: string } | undefined) {
  const dir = context?.project ?? context?.cwd;
  if (!dir || ws.data.view || trimSlash(dir) === ws.data.project) return;
  ws.data.project = trimSlash(dir);
  const key = windowKey(ws.data.host, ws.data.project);
  const was = opening.get(key);
  opening.delete(key);
  if (was && Date.now() - was.at < OPENING_MS) for (const run of was.runs) handoff(ws, run);
  tellWindows();
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

const ISOLATED = { "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
const IMMUTABLE = "private, max-age=31536000, immutable";

// What of Neovim's runtimepath never changes, whole, for the page to keep
// (wasm.snapshot), at a URL that changes when it does.
const SNAPSHOT_ROOTS = wasm.snapshotRoots([PLUGIN_ROOT, ...PLUGINS]);
const SNAPSHOT_KEY = createHash("sha256").update(SNAPSHOT_ROOTS.join("\0")).digest("hex").slice(0, 16);
let snapshotBytes: Uint8Array | undefined;

function snapshotFile(req: Request, url: URL): Response {
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  if (url.pathname !== `/host/snapshot/${SNAPSHOT_KEY}` || !SNAPSHOT_ROOTS.length) return new Response("not found", { status: 404 });
  snapshotBytes ??= wasm.snapshot(SNAPSHOT_ROOTS);
  return new Response(snapshotBytes, { headers: { ...ISOLATED, "content-type": "application/msgpack", "cache-control": IMMUTABLE } });
}

// For a page with no machine (?wasm=ephemeral, web/src/nvim/wasm/machine):
// where Neovim is, and the plugins' files (wasm.bundle), at a URL that
// changes with them. Remade for each page, since the plugin is edited here.
let bundled: { key: string; bytes: Uint8Array } | undefined;
function wasmManifest(req: Request): Response {
  const why = refuseFetch(req);
  if (why) return new Response(why, { status: 403 });
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  if (!NVIM_WASM) return new Response("CORKBOARD_NVIM_WASM is not set", { status: 404 });
  const { names, bytes } = wasm.bundle([PLUGIN_ROOT, ...PLUGINS]);
  bundled = { key: createHash("sha256").update(bytes).digest("hex").slice(0, 16), bytes };
  return Response.json({ wasm: `wasm/${WASM_VERSION}/`, plugins: `wasm/plugins/${bundled.key}`, rtp: names }, { headers: { "cache-control": "no-store" } });
}
function wasmPlugins(req: Request, url: URL): Response {
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  if (!bundled || url.pathname !== `/wasm/plugins/${bundled.key}`) return new Response("not found", { status: 404 });
  return new Response(bundled.bytes, { headers: { ...ISOLATED, "content-type": "application/msgpack", "cache-control": IMMUTABLE } });
}

// /api/git/: the Worker's, with this bridge's sign-in, for a page with no
// machine that this bridge serves. The Worker serving the page itself does
// the same on its own origin (cloud/src/git.ts); the page asks either alike.
async function gitProxy(req: Request, url: URL): Promise<Response> {
  const why = refuseFetch(req);
  if (why || (req.method !== "GET" && req.method !== "POST")) return new Response(why ?? "GET or POST", { status: 403 });
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  const headers = new Headers({ Authorization: `Bearer ${await token()}` });
  for (const h of ["Content-Type", "Accept", "Git-Protocol", "Content-Encoding"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const res = await fetch(`${CLOUD}${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined });
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } });
}

// The pages whose Neovim is theirs, by the id their worker calls /host with.
const hosts = new Map<string, wasm.Host>();

function startWasm(ws: Bun.ServerWebSocket<Session>) {
  const data = ws.data;
  data.toPage = (msg) => ws.send(JSON.stringify(msg, toJson));
  // As spawnLocal gives it to Neovim, which its processes inherit.
  const env = { ...(process.env as Record<string, string>), CORKBOARD_CLOUD: CLOUD, ...(data.view ? { CORKBOARD_WINDOW: data.view } : {}) };
  const host = new wasm.Host(
    (code, ...args) => deliver(data, [2, "nvim_exec_lua", [code, args]]),
    (tag, method, params) => data.toPage!([10, tag, method, params]),
    env,
  );
  data.wasmHost = host;
  hosts.set(host.id, host);
  const rtp = `set rtp^=${[PLUGIN_ROOT, ...PLUGINS].map((p) => p.replace(/[ \\,]/g, "\\$&")).join(",")}`;
  notifyPage(ws, "corkboard.host", {
    id: host.id,
    cwd: data.cwd,
    home: homedir(),
    mounts: wasm.mounts(),
    seeds: wasm.seeds(data.cwd, homedir(), env),
    wasm: `wasm/${WASM_VERSION}/`,
    snapshot: SNAPSHOT_ROOTS.length ? `host/snapshot/${SNAPSHOT_KEY}` : null,
    env,
    // Its processes start Neovim too (the hooks' `nvim -l`), this machine's.
    args: ["--cmd", rtp, "--cmd", `let g:corkboard_wasm = 1 | let g:corkboard_server = '${host.socket}' | let g:corkboard_nvim = '${Bun.which(NVIM) ?? NVIM}'`],
  });
}

// From a page whose Neovim is its own: what that Neovim said for the bridge,
// and answers to the hooks' requests.
function fromWasm(ws: Bun.ServerWebSocket<Session>, msg: any[]) {
  if (msg[0] === 10) return ws.data.wasmHost!.reply(msg[1], msg[2], msg[3]);
  if (msg[0] === 2 && msg[1] === AWAY_METHOD) return awayFrom(ws.data, msg[2]);
  if (msg[0] === 2 && msg[1] === WINDOW_METHOD) {
    const [cwd] = msg[2];
    if (typeof cwd === "string") openWindow(ws, cwd);
    return;
  }
  fromNvim(ws, msg);
}

// /host/fs and /host/lua, from a page's worker: as guarded as the socket
// (its origin, the token), and for a page that has one open.
async function hostCall(req: Request, url: URL): Promise<Response> {
  const why = refuse(req);
  if (why || req.method !== "POST") return new Response(why ?? "POST", { status: 403 });
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  const host = hosts.get(url.searchParams.get("s") ?? "");
  if (!host) return new Response("no such page", { status: 404 });
  const body = new Uint8Array(await req.arrayBuffer());
  const out = url.pathname === "/host/fs" ? host.fs(body) : await host.lua(body);
  return new Response(out, { headers: { "content-type": "application/msgpack" } });
}

// /latency: a page's key-to-pixels timings (web/src/latency.ts), one line
// per key with the window it came from, for `bun run latency` and for
// lining up with whatever else the machine was doing at the time.
const LATENCY_LOG = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard", "latency.jsonl");
async function latency(req: Request): Promise<Response> {
  const why = refuse(req);
  if (why || req.method !== "POST") return new Response(why ?? "POST", { status: 403 });
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  const { samples, ...page } = (await req.json()) as { samples?: unknown[] };
  if (!Array.isArray(samples)) return new Response("samples", { status: 400 });
  mkdirSync(dirname(LATENCY_LOG), { recursive: true });
  appendFileSync(LATENCY_LOG, samples.map((s) => JSON.stringify({ ...(s as object), ...page }) + "\n").join(""));
  return new Response(null, { status: 204 });
}

// /media/<board>/<card>/<id>: a file an agent attached to a card, from the
// Worker with the bridge's sign-in, for the page's media panel. The token
// header is the guard: a page elsewhere can't send it without a preflight
// the bridge never answers, and a same-origin GET carries no Origin.
const MEDIA_PATH = /^\/media\/([A-Za-z0-9._-]{1,128})\/([A-Za-z]+-\d+)\/([0-9a-f]{12})$/;
async function media(req: Request, url: URL): Promise<Response> {
  if (TOKEN && !sameToken(req.headers.get("x-corkboard-token") ?? "")) return new Response("wrong token", { status: 403 });
  if (!TOKEN && !isLoopback(url.hostname)) return new Response(`wrong host: ${url.host}`, { status: 403 });
  const m = url.pathname.match(MEDIA_PATH);
  if (!m || req.method !== "GET") return new Response("not found", { status: 404 });
  const res = await fetch(`${CLOUD}/api/boards/${m[1]}/cards/${m[2]}/media/${m[3]}`, { headers: { Authorization: `Bearer ${await token()}` } });
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  for (const h of ["content-type", "content-length", "etag", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
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
      if (inPage(url) && !data.error) {
        if (data.host) data.error = "a page on another machine runs Neovim there, not in wasm";
        else if (!NVIM_WASM) data.error = "CORKBOARD_NVIM_WASM is not set";
        else data.wasm = true;
      }
      // The browser drops a socket whose reply names no protocol it offered.
      const headers = offered.includes("corkboard") ? { "sec-websocket-protocol": "corkboard" } : undefined;
      return server.upgrade(req, { data, headers }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/open") return open(url.searchParams.get("ticket") ?? "");
    if (url.pathname === "/host/fs" || url.pathname === "/host/lua") return hostCall(req, url);
    if (url.pathname === "/latency") return latency(req);
    if (url.pathname === "/wasm/manifest") return wasmManifest(req);
    if (url.pathname.startsWith("/wasm/plugins/")) return wasmPlugins(req, url);
    if (url.pathname.startsWith("/api/git/")) return gitProxy(req, url);
    if (url.pathname.startsWith("/media/")) return media(req, url);
    if (url.pathname.startsWith(`/host/snapshot/`)) return snapshotFile(req, url);
    if (url.pathname.startsWith(`/wasm/${WASM_VERSION}/`) && NVIM_WASM) {
      const name = url.pathname.split("/").at(-1)!;
      const file = Bun.file(`${NVIM_WASM}/${name}`);
      if (!/^nvim\.(js|wasm|data)$/.test(name) || !(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { ...ISOLATED, "cache-control": IMMUTABLE } });
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // The page, as one that runs Neovim itself, unless it said otherwise.
    // The fragment (#token=) goes with the redirect.
    if (path === "index.html" && WASM_DEFAULT && !url.searchParams.has("wasm") && !url.searchParams.has("host")) {
      url.searchParams.set("wasm", "");
      return new Response(null, { status: 302, headers: { location: `${url.pathname}${url.search}` } });
    }
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
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    // The page that runs Neovim itself needs SharedArrayBuffer, and so
    // cross-origin isolation.
    return new Response(file, { headers: path === "index.html" && inPage(url) ? { ...ISOLATED, "cross-origin-opener-policy": "same-origin" } : ISOLATED });
  },

  websocket: {
    open(ws) {
      if (ws.data.error) return ws.close(4000, closeReason(ws.data.error));
      pages.add(ws);
      ws.data.page = {
        host: ws.data.host,
        notify: (method, ...params) => ws.send(JSON.stringify([2, method, params])),
        exec: (code, ...args) => deliver(ws.data, [2, "nvim_exec_lua", [code, args]]),
      };
      away.opened(ws.data.page);
      // One day plan at a time: a new plan window takes over from the old.
      if (ws.data.view === "plan") {
        planWindow?.close(4002, "the day plan opened in another window");
        planWindow = ws;
      }
      if (ws.data.wasm) return startWasm(ws);
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
      const text = String(raw);
      if (ws.data.wasmHost) return fromWasm(ws, JSON.parse(text));
      if (text.startsWith(`[2,"${AWAY_METHOD}"`)) return awayFrom(ws.data, JSON.parse(text)[2]);
      if (text.startsWith(`[2,"${WINDOW_METHOD}"`)) {
        const [cwd] = JSON.parse(text)[2];
        if (typeof cwd === "string") openWindow(ws, cwd);
        return;
      }
      if (ws.data.nvim) toNvim(ws.data.nvim, text);
      else ws.data.queued?.push(text);
    },

    close(ws) {
      if (planWindow === ws) planWindow = undefined;
      pages.delete(ws);
      if (ws.data.project) tellWindows();
      if (ws.data.page) away.closed(ws.data.page);
      ws.data.closed = true;
      ws.data.cloud?.close();
      ws.data.nvim?.kill();
      if (ws.data.wasmHost) hosts.delete(ws.data.wasmHost.id);
      ws.data.wasmHost?.close();
    },
  },
});

console.log(`corkboard on ${ORIGIN ?? `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`}/${TOKEN ? `#token=${TOKEN}` : ""}`);

// What the phone needs from this machine (phone.ts), and from this bridge (remote.ts).
phone.start();
remote.start(PORT);
