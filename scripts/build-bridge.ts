// The bridge as one executable, with what it serves and runs beside it,
// for the desktop app (app/electron-builder.yml) to carry:
//
//   bun scripts/build-bridge.ts [--target linux-x64,...|linux|mac|win|os|all] [--no-nvim] [--no-speech]
//
// Into dist/bridge/<os>-<arch>/, named as electron-builder names them
// (linux, mac, win; x64, arm64), for each target (this machine's by default):
//
//   corkboard-bridge[.exe]   bun build --compile of bridge/main.ts
//   resources/               dirs.ts's RESOURCES: web/dist, nvim/, mcp/,
//                            bridge/chatterbox-speech.py, rev, and the
//                            speech's node_modules (onnxruntime-node's
//                            binaries for that system only)
//   nvim/                    Neovim's own release for that system, at the
//                            version the flake builds (neovim-src)
//
// The page is built first if web/dist isn't there (`bun run build`).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "bridge");

// Neovim's version, from the flake's neovim-src, so the app's and the
// flake's are the same.
const NVIM_VERSION = readFileSync(join(ROOT, "flake.nix"), "utf8").match(/github:neovim\/neovim\/(v[\d.]+)/)![1];

type Target = { bun: string; os: "linux" | "mac" | "win"; arch: "x64" | "arm64"; nvim: string; ort?: string };
const TARGETS: Record<string, Target> = {
  "linux-x64": { bun: "bun-linux-x64", os: "linux", arch: "x64", nvim: "nvim-linux-x86_64.tar.gz", ort: "linux/x64" },
  "linux-arm64": { bun: "bun-linux-arm64", os: "linux", arch: "arm64", nvim: "nvim-linux-arm64.tar.gz", ort: "linux/arm64" },
  // onnxruntime-node has no Intel Mac binaries: no voice there.
  "mac-x64": { bun: "bun-darwin-x64", os: "mac", arch: "x64", nvim: "nvim-macos-x86_64.tar.gz" },
  "mac-arm64": { bun: "bun-darwin-arm64", os: "mac", arch: "arm64", nvim: "nvim-macos-arm64.tar.gz", ort: "darwin/arm64" },
  "win-x64": { bun: "bun-windows-x64", os: "win", arch: "x64", nvim: "nvim-win64.zip", ort: "win32/x64" },
};
const OS = { linux: "linux", darwin: "mac", win32: "win" } as Record<string, string>;
const HERE = `${OS[process.platform]}-${process.arch}`;

// The speech's packages, as the flake's default package takes them.
const SPEECH = ["kokoro-js", "phonemizer", "@huggingface/transformers", "onnxruntime-node", "onnxruntime-common"];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// "os": all of this OS's.
const wanted = (option("--target") ?? HERE).replace(/\bos\b/, OS[process.platform]);
// An OS alone is all its targets.
const names = wanted.split(",").flatMap((n) => {
  const of = Object.keys(TARGETS).filter((k) => n === "all" || k.startsWith(`${n}-`));
  return TARGETS[n] || !of.length ? [n] : of;
});
for (const n of names) if (!TARGETS[n]) throw new Error(`no such target: ${n} (${Object.keys(TARGETS).join(", ")})`);

function run(cmd: string[], cwd = ROOT) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!proc.success) throw new Error(`${cmd.join(" ")}: exit ${proc.exitCode}`);
}

const rev = (() => {
  const git = Bun.spawnSync(["git", "-C", ROOT, "describe", "--always", "--dirty"], { stderr: "ignore" });
  return git.success ? git.stdout.toString().trim() : "?";
})();
const version = JSON.parse(readFileSync(join(ROOT, "app", "package.json"), "utf8")).version as string;

if (!existsSync(join(ROOT, "web", "dist", "index.html"))) run(["bun", "run", "build"]);

// The same Neovim for every target that wants it, downloaded once.
const CACHE = join(ROOT, "dist", "cache");
async function download(name: string): Promise<string> {
  const file = join(CACHE, `${NVIM_VERSION}-${name}`);
  if (existsSync(file)) return file;
  const url = `https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/${name}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(CACHE, { recursive: true });
  await Bun.write(`${file}.part`, res);
  renameSync(`${file}.part`, file);
  return file;
}

// The archive's one top-level directory (nvim-linux-x86_64/, nvim-win64/)
// becomes dest itself.
function unpack(archive: string, dest: string) {
  const tmp = `${dest}.unpack`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Windows' tar (bsdtar) reads zips too; elsewhere unzip does.
  if (archive.endsWith(".zip") && process.platform !== "win32") run(["unzip", "-q", archive, "-d", tmp]);
  else run(["tar", "-xf", archive, "-C", tmp]);
  const [top] = readdirSync(tmp);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(tmp, top), dest, { recursive: true, verbatimSymlinks: true });
  rmSync(tmp, { recursive: true, force: true });
}

for (const name of names) {
  const t = TARGETS[name];
  const dir = join(OUT, name);
  const res = join(dir, "resources");
  console.log(`\n${name}: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(res, { recursive: true });

  run([
    "bun", "build", "--compile", `--target=${t.bun}`, "--minify-syntax", "--sourcemap=none",
    // Without it, the executable finds no package in a node_modules on disk.
    "--compile-autoload-package-json",
    // Loaded at run time from resources/node_modules (speech.ts's sidecar).
    ...SPEECH.flatMap((p) => ["--external", p]),
    "bridge/main.ts", "--outfile", join(dir, "corkboard-bridge"),
  ]);

  cpSync(join(ROOT, "web", "dist"), join(res, "web", "dist"), { recursive: true });
  cpSync(join(ROOT, "nvim"), join(res, "nvim"), { recursive: true });
  cpSync(join(ROOT, "mcp"), join(res, "mcp"), { recursive: true });
  mkdirSync(join(res, "bridge"));
  cpSync(join(ROOT, "bridge", "chatterbox-speech.py"), join(res, "bridge", "chatterbox-speech.py"));
  writeFileSync(join(res, "rev"), `${version} ${rev}\n`);
  writeFileSync(join(res, "nvim", "rev"), `${rev}\n`);

  if (t.ort && !flag("--no-speech")) {
    for (const p of SPEECH) cpSync(join(ROOT, "node_modules", p), join(res, "node_modules", p), { recursive: true, verbatimSymlinks: true });
    // onnxruntime's binaries for this target only, of the five it ships.
    const ort = join(res, "node_modules", "onnxruntime-node", "bin", "napi-v6");
    for (const os of readdirSync(ort)) {
      for (const arch of readdirSync(join(ort, os))) if (`${os}/${arch}` !== t.ort) rmSync(join(ort, os, arch), { recursive: true });
    }
    // transformers.js wants sharp, for images, to be there; speech never calls it.
    mkdirSync(join(res, "node_modules", "sharp"));
    writeFileSync(join(res, "node_modules", "sharp", "package.json"), '{"name":"sharp","main":"index.js"}\n');
    writeFileSync(join(res, "node_modules", "sharp", "index.js"), 'module.exports = () => { throw new Error("no sharp"); };\n');
  }

  if (!flag("--no-nvim")) unpack(await download(t.nvim), join(dir, "nvim"));
}
