import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isUnder, pathKey } from "./dirs";

// These are a unix machine's; a Windows one's separators are another test's.
describe("paths", () => {
  it("are under a directory only past a separator", () => {
    expect(isUnder("/home/me/proj/src/a.ts", "/home/me/proj")).toBe(true);
    expect(isUnder("/home/me/proj/", "/home/me/proj")).toBe(true);
    // The directory itself isn't under it, nor one whose name starts the same.
    expect(isUnder("/home/me/proj", "/home/me/proj")).toBe(false);
    expect(isUnder("/home/me/project", "/home/me/proj")).toBe(false);
    expect(isUnder("/home/me/proj-old/a", "/home/me/proj")).toBe(false);
    expect(isUnder("/home/me", "/home/me/proj")).toBe(false);
    // A backslash is a name's own here.
    expect(isUnder("/home/me/proj\\a", "/home/me/proj")).toBe(false);
  });

  it("make one directory name, as util.path_key does", () => {
    expect(pathKey("/home/me/proj")).toBe("home-me-proj");
    expect(pathKey("/")).toBe("");
    expect(pathKey("relative/dir")).toBe("relative-dir");
    // Only the first slash goes; ":" and "\" stay, so no board moves.
    expect(pathKey("//srv/x")).toBe("-srv-x");
    expect(pathKey("/mnt/C:\\x")).toBe("mnt-C:\\x");
  });
});

// Where corkboard keeps things: the environment's at load, so each case is
// a process of its own.
describe("the state, data and cache directories", () => {
  const dirs = (env: Record<string, string>) => {
    const out = Bun.spawnSync(["bun", "-e", `const d = await import(${JSON.stringify(join(import.meta.dir, "dirs.ts"))}); console.log(JSON.stringify(d.dirsEnv))`], {
      env: { PATH: process.env.PATH!, HOME: "/home/test", ...env },
    });
    if (out.exitCode) throw new Error(out.stderr.toString());
    return JSON.parse(out.stdout.toString());
  };

  it("are XDG's on Linux, a set XDG variable winning, and Neovim's word over both", () => {
    if (process.platform !== "linux") return;
    expect(dirs({})).toEqual({
      CORKBOARD_STATE_DIR: "/home/test/.local/state/corkboard",
      CORKBOARD_DATA_DIR: "/home/test/.local/share/corkboard",
      CORKBOARD_CACHE_DIR: "/home/test/.cache/corkboard",
    });
    expect(dirs({ XDG_STATE_HOME: "/x/state", XDG_CACHE_HOME: "/x/cache" })).toEqual({
      CORKBOARD_STATE_DIR: "/x/state/corkboard",
      CORKBOARD_DATA_DIR: "/home/test/.local/share/corkboard",
      CORKBOARD_CACHE_DIR: "/x/cache/corkboard",
    });
    expect(dirs({ XDG_DATA_HOME: "/x/data", CORKBOARD_DATA_DIR: "/nvim/data" }).CORKBOARD_DATA_DIR).toBe("/nvim/data");
  });
});
