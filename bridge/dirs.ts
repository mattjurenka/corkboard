// Where corkboard keeps things on this machine, and where its own files are.
//
// state (the account key, the projects opened, latency), data (boards, card
// worktrees) and cache (the speech model): XDG's on Linux, as they always
// were; ~/Library on macOS; %LOCALAPPDATA% on Windows. An XDG_* variable
// that is set wins anywhere. The bridge hands them to Neovim as
// CORKBOARD_{STATE,DATA,CACHE}_DIR (util.lua), and so to what Neovim starts
// (mcp/cards.ts), so all of them agree.
//
// RESOURCES: the page (web/dist), the plugin (nvim/) and mcp/, laid out as
// in the repo. CORKBOARD_RESOURCES or --resources <dir>; else, compiled
// (scripts/build-bridge.ts), resources/ beside the executable; else the
// source tree this file is in, which the Nix package lays out the same way.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = homedir();
const env = process.env;

function base(kind: "state" | "data" | "cache"): string {
  const xdg = { state: env.XDG_STATE_HOME, data: env.XDG_DATA_HOME, cache: env.XDG_CACHE_HOME }[kind];
  if (xdg) return join(xdg, "corkboard");
  if (process.platform === "darwin") {
    return kind === "cache" ? join(home, "Library", "Caches", "corkboard") : join(home, "Library", "Application Support", "corkboard", kind);
  }
  if (process.platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "corkboard", kind);
  return join(home, { state: ".local/state", data: ".local/share", cache: ".cache" }[kind], "corkboard");
}

// Neovim's word for them, when it started this (or something it started).
export const STATE_DIR = env.CORKBOARD_STATE_DIR || base("state");
export const DATA_DIR = env.CORKBOARD_DATA_DIR || base("data");
export const CACHE_DIR = env.CORKBOARD_CACHE_DIR || base("cache");

export const dirsEnv = { CORKBOARD_STATE_DIR: STATE_DIR, CORKBOARD_DATA_DIR: DATA_DIR, CORKBOARD_CACHE_DIR: CACHE_DIR };

// bun build --compile puts the code in a filesystem of its own: /$bunfs/
// on unix, B:\~BUN\ on Windows.
export const COMPILED = /^\/\$bunfs\/|[\\/]~BUN[\\/]/.test(import.meta.dir);

function resources(): string {
  const flag = process.argv.indexOf("--resources");
  const given = env.CORKBOARD_RESOURCES || (flag > 0 ? process.argv[flag + 1] : undefined);
  if (given) return resolve(given);
  if (COMPILED) {
    const beside = join(dirname(process.execPath), "resources");
    if (existsSync(beside)) return beside;
  }
  return resolve(import.meta.dir, "..");
}
export const RESOURCES = resources();

// A path's start, for "is this under that": the separators this OS has.
export const SEP = process.platform === "win32" ? /[\\/]/ : /\//;
export const isUnder = (path: string, dir: string) =>
  path.length > dir.length && path.startsWith(dir) && SEP.test(path[dir.length]);

// A path as one directory name, as util.path_key has it: /home/me/proj ->
// home-me-proj. On Windows, C:\Users\me\proj -> C-Users-me-proj; elsewhere
// ":" and "\" are a name's own and stay, so no existing board moves.
export const pathKey = (path: string) =>
  process.platform === "win32"
    ? path.replace(/^([A-Za-z]):/, "$1").replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")
    : path.replace(/^\//, "").replaceAll("/", "-");
