// The `browser` capability's MCP server, on stdio: Playwright's own MCP tools
// (navigate, click, type, snapshot, screenshot, tabs, console, network, and
// browser_run_code_unsafe for anything they don't cover), in front of a browser this
// process launches, so a run can say which extensions it has. Chromium only
// takes those at launch, so browser_start is a new browser and a new
// Playwright connection behind the one the client holds; with no
// browser_start the first tool call launches one with none. Beyond the tools,
// anything that speaks CDP can attach at CDP.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const CDP_PORT = 9222;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
// The Web Store's update service wants a browser version; any recent one will do.
const STORE_URL = (id: string) =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=153.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
const PROFILES = join(process.env.HOME ?? tmpdir(), ".cache/fleet-browser/profiles");
// The server runs from its output directory; a path an agent gives is from where it was started.
const STARTED_IN = process.cwd();

// The Web Store ID in a bare ID or a store link, or null.
export function storeId(spec: string): string | null {
  if (/^[a-p]{32}$/.test(spec)) return spec;
  return /^https:\/\/(chrome\.google|chromewebstore\.google)\.com\/.*?\/([a-p]{32})(?:[/?#]|$)/.exec(spec)?.[2] ?? null;
}

// A .crx is a zip behind a header.
export function zipOf(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 4).toString("latin1") !== "Cr24") return bytes;
  return bytes.subarray(12 + bytes.readUInt32LE(8));
}

// The ID Chromium gives an unpacked extension: from the manifest's key, or
// with none from where it was loaded.
export function extensionId(dir: string, key?: string): string {
  const seed = key ? Buffer.from(key, "base64") : Buffer.from(dir);
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// Playwright names the files it writes relative to its working directory,
// which isn't the agent's.
export function absoluteLinks(text: string, dir: string): string {
  return text.replace(/^(- \[.*?\]\(|- New console entries: |- Downloaded file .* to ")(.+?)(\)|"|)$/gm, (all, before, path, after) =>
    /^[a-z][a-z+.-]*:/i.test(path) ? all : before + resolve(dir, path) + after);
}

// The directory under `dir` with the manifest: its top, or one folder down.
function manifestDir(dir: string): string {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  for (const e of readdirSync(dir)) {
    if (existsSync(join(dir, e, "manifest.json"))) return join(dir, e);
  }
  throw new Error("no manifest.json in it");
}

async function unpack(spec: string, work: string, n: number): Promise<string> {
  const id = storeId(spec);
  let bytes: Buffer;
  if (id || /^https?:/.test(spec)) {
    const res = await fetch(id ? STORE_URL(id) : spec);
    if (!res.ok) throw new Error(`download: ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else if (statSync(resolve(STARTED_IN, spec)).isDirectory()) {
    return manifestDir(resolve(STARTED_IN, spec));
  } else {
    bytes = readFileSync(resolve(STARTED_IN, spec));
  }
  const dir = join(work, `extension-${n}`);
  mkdirSync(dir, { recursive: true });
  const zip = join(work, `extension-${n}.zip`);
  writeFileSync(zip, zipOf(bytes));
  execFileSync("unzip", ["-qo", zip, "-d", dir], { stdio: "ignore" });
  return manifestDir(dir);
}

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
type Extension = { source: string; id: string; name: string; version: string; popup: string | null };

const START_TOOL = {
  name: "browser_start",
  description: `Start a new headless Chromium with the given extensions, replacing any browser already running. Extensions only load at launch, so this is how to change them. An extension's own windows (a wallet's approval popup, say) open as tabs: see browser_tabs. Raw CDP is at ${CDP} for tools of your own; browser_run_code_unsafe runs Playwright code against the page.`,
  inputSchema: {
    type: "object",
    properties: {
      extensions: {
        type: "array",
        items: { type: "string" },
        description: "Each a Chrome Web Store ID or link, a URL to a .crx or .zip, or a path to one or to an unpacked directory",
      },
      profile: {
        type: "string",
        description: "A name to keep the browser's state under for later runs in this VM; without one it starts empty",
      },
    },
  },
};
const STOP_TOOL = {
  name: "browser_stop",
  description: "Close the browser. A profile named at browser_start keeps its state.",
  inputSchema: { type: "object", properties: {} },
};

if (import.meta.main) {
  const root = process.env.PLAYWRIGHT_MCP_ROOT;
  if (!root) throw new Error("PLAYWRIGHT_MCP_ROOT isn't set");
  const require = createRequire(join(root, "index.js"));
  const { createConnection } = require("./index.js");
  const { chromium } = require("playwright-core");

  const output = (m: Message) => process.stdout.write(JSON.stringify(m) + "\n");
  const outputDir = process.env.BROWSER_OUTPUT_DIR ?? join(tmpdir(), "fleet-browser-output");
  // A screenshot's filename is relative to the working directory, not to outputDir.
  mkdirSync(outputDir, { recursive: true });
  process.chdir(outputDir);

  let context: any = null;
  let inner: { send: (m: Message) => void; close: () => Promise<void> };
  let initialize: Message | null = null;
  let quiet = 0;

  async function launch(dirs: string[], profile?: string) {
    const userData = profile ? join(PROFILES, profile) : mkdtempSync(join(tmpdir(), "fleet-browser-"));
    mkdirSync(userData, { recursive: true });
    const list = dirs.join(",");
    const c = await chromium.launchPersistentContext(userData, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        ...(dirs.length ? [`--disable-extensions-except=${list}`, `--load-extension=${list}`] : []),
      ],
    });
    c.on("close", () => { if (context === c) context = null; });
    context = c;
    return c;
  }

  async function connect() {
    const server = await createConnection(
      // The VM is the sandbox, so a file to upload can be anywhere in it.
      { browser: { browserName: "chromium" }, outputDir, allowUnrestrictedFileAccess: true, capabilities: ["core", "core-navigation", "core-tabs", "core-input", "network", "storage", "pdf", "devtools"] },
      async () => context ?? launch([]),
    );
    const transport: any = {
      start: async () => {},
      close: async () => {},
      send: async (m: Message) => {
        if (typeof m.id === "string" && m.id.startsWith("fleet-")) return;
        output(m);
      },
    };
    await server.connect(transport);
    inner = {
      send: (m) => transport.onmessage(m),
      close: () => server.close(),
    };
    if (initialize) {
      inner.send({ ...initialize, id: `fleet-${quiet++}` });
      inner.send({ method: "notifications/initialized" });
    }
  }

  async function stop() {
    const c = context;
    context = null;
    await c?.close().catch(() => {});
    await inner.close().catch(() => {});
    await connect();
  }

  async function start(args: { extensions?: string[]; profile?: string }): Promise<object> {
    if (args.profile && !/^[\w-]+$/.test(args.profile)) throw new Error("a profile's name is letters, digits, _ and -");
    await stop();
    const specs = args.extensions ?? [];
    const work = mkdtempSync(join(tmpdir(), "fleet-browser-ext-"));
    const extensions: Extension[] = [];
    const dirs: string[] = [];
    for (const [n, source] of specs.entries()) {
      let dir: string;
      try {
        dir = await unpack(source, work, n);
      } catch (e) {
        throw new Error(`${source}: ${(e as Error).message}`);
      }
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const id = extensionId(dir, manifest.key);
      const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
      dirs.push(dir);
      extensions.push({ source, id, name: manifest.name, version: manifest.version, popup: popup ? `chrome-extension://${id}/${popup}` : null });
    }
    await launch(dirs, args.profile);
    return { cdp: CDP, extensions };
  }

  async function handle(m: Message) {
    // Playwright would take the client's first root as its working directory.
    if (m.method === "initialize") {
      m = initialize = { ...m, params: { ...m.params, capabilities: { ...m.params?.capabilities, roots: undefined } } };
    }
    if (m.method === "tools/call" && (m.params?.name === "browser_start" || m.params?.name === "browser_stop")) {
      try {
        const result = m.params.name === "browser_start" ? await start(m.params.arguments ?? {}) : (await stop(), { stopped: true });
        output({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (e) {
        output({ id: m.id, result: { isError: true, content: [{ type: "text", text: (e as Error).message }] } });
      }
      return;
    }
    inner.send(m);
  }

  // tools/list is Playwright's answer with these two in and its browser_close
  // out, since browser_stop is what closes the browser here.
  const listing = new Set<string | number>();
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    const m: Message = JSON.parse(chunk);
    if (m.id !== undefined && listing.delete(m.id) && m.result?.tools) {
      m.result.tools = [START_TOOL, STOP_TOOL, ...m.result.tools.filter((t: { name: string }) => t.name !== "browser_close")];
    }
    for (const c of m.result?.content ?? []) {
      if (c.type === "text") c.text = absoluteLinks(c.text, process.cwd());
    }
    return write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  }) as typeof process.stdout.write;

  await connect();
  let queue: Promise<void> = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    const m: Message = JSON.parse(line);
    if (m.method === "tools/list" && m.id !== undefined) listing.add(m.id);
    queue = queue.then(() => handle(m)).catch((e) => process.stderr.write(`${e}\n`));
  }).on("close", () => {
    void context?.close().finally(() => process.exit(0)) ?? process.exit(0);
  });
}
