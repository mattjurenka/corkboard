// packaging/aur and packaging/homebrew's update.sh, on copies of what they
// edit, with gh and curl stood in for by a release of the test's: what they
// write for a new version, and that they write nothing for a release
// without its files.   bun test packaging
import { beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const bin = () => join(dir, "bin");
const sha = (c: string) => c.repeat(64);


beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "packaging-"));
  cpSync(import.meta.dir, join(dir, "packaging"), { recursive: true });
  mkdirSync(bin());
  // gh api repos/<repo>/releases/tags/<tag> -q '.assets[] | select(.name == "<name>") | .digest'
  writeFileSync(
    join(bin(), "gh"),
    `#!/usr/bin/env bun
const [, , api, path, q, filter] = process.argv;
if (api !== "api" || q !== "-q") process.exit(2);
const release = JSON.parse(await Bun.file(${JSON.stringify(join(dir, "release.json"))}).text());
if (path !== "repos/mattjurenka/corkboard/releases/tags/" + release.tag) { console.error("gh: HTTP 404: Not Found"); process.exit(1); }
const name = filter.match(/select\\(\\.name == "([^"]+)"\\) \\| \\.digest$/)?.[1];
for (const a of release.assets) if (a.name === name) console.log(a.digest);
`,
  );
  // curl -fsSL <url> -o <file>: the url's own bytes.
  writeFileSync(join(bin(), "curl"), `#!/bin/sh\necho "$2" >> ${join(dir, "fetched")}\nprintf 'bytes of %s' "$2" > "$4"\n`);
  chmodSync(join(bin(), "gh"), 0o755);
  chmodSync(join(bin(), "curl"), 0o755);
});

// The release, as gh api has it: its assets' names and digests.
function release(tag: string, assets: { name: string; digest: string }[]) {
  writeFileSync(join(dir, "release.json"), JSON.stringify({ tag, assets }));
}

function update(which: "aur" | "homebrew", version: string) {
  const p = Bun.spawnSync(["bash", join(dir, "packaging", which, "update.sh"), version], { env: { ...process.env, PATH: `${bin()}:${process.env.PATH}` } });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

const file = (...p: string[]) => readFileSync(join(dir, "packaging", ...p), "utf8");
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// The PKGBUILD's variables, as makepkg would source them.
function sourced(): Map<string, string> {
  const vars = ["_version", "pkgver", "pkgrel", "sha256sums[0]", "sha256sums[1]", "sha256sums_x86_64[0]", "sha256sums_aarch64[0]", "source[1]", "source_x86_64[0]", "source_aarch64[0]"];
  const p = Bun.spawnSync(["bash", "-c", `. ./PKGBUILD; for v in ${vars.map((v) => `"\${${v}}"`).join(" ")}; do echo "$v"; done`], { cwd: join(dir, "packaging/aur/corkboard-bin") });
  const lines = p.stdout.toString().split("\n");
  return new Map(vars.map((v, i) => [v, lines[i]]));
}

// .SRCINFO's key = value lines, repeated keys in order.
const srcinfo = () => file("aur/corkboard-bin/.SRCINFO").split("\n").filter((l) => l.includes(" = ")).map((l) => l.trim().split(" = ") as [string, string]);
const values = (k: string) => srcinfo().filter(([key]) => key === k).map(([, v]) => v);

test("the AUR package at an rc: its version, the tarballs' digests, the icon's and desktop file's sums, and a .SRCINFO that agrees", () => {
  release("v0.2.0-rc3", [
    { name: "corkboard-0.2.0-rc3-linux-x64.tar.gz", digest: `sha256:${sha("a")}` },
    { name: "corkboard-0.2.0-rc3-linux-arm64.tar.gz", digest: `sha256:${sha("b")}` },
    { name: "corkboard-0.2.0-rc3-mac-arm64.dmg", digest: `sha256:${sha("c")}` },
  ]);
  writeFileSync(join(dir, "packaging/aur/corkboard-bin/PKGBUILD"), file("aur/corkboard-bin/PKGBUILD").replace(/^pkgrel=1$/m, "pkgrel=4"));
  expect(update("aur", "0.2.0-rc3")).toEqual({ code: 0, out: "corkboard-bin 0.2.0rc3", err: "" });
  const icon = "https://raw.githubusercontent.com/mattjurenka/corkboard/v0.2.0-rc3/app/build/icons/512x512.png";
  expect(readFileSync(join(dir, "fetched"), "utf8")).toBe(icon + "\n");
  const desktop = sha256(file("aur/corkboard-bin/corkboard.desktop"));
  const v = sourced();
  expect(Object.fromEntries(v)).toEqual({
    _version: "0.2.0-rc3",
    pkgver: "0.2.0rc3",
    pkgrel: "1",
    "sha256sums[0]": desktop,
    "sha256sums[1]": sha256(`bytes of ${icon}`),
    "sha256sums_x86_64[0]": sha("a"),
    "sha256sums_aarch64[0]": sha("b"),
    "source[1]": `corkboard-0.2.0rc3.png::${icon}`,
    "source_x86_64[0]": "corkboard-0.2.0-rc3-linux-x64.tar.gz::https://corkboard.fyi/d/corkboard-0.2.0-rc3-linux-x64.tar.gz?r=aur",
    "source_aarch64[0]": "corkboard-0.2.0-rc3-linux-arm64.tar.gz::https://corkboard.fyi/d/corkboard-0.2.0-rc3-linux-arm64.tar.gz?r=aur",
  });
  // .SRCINFO says what the PKGBUILD does.
  expect(values("pkgver")).toEqual([v.get("pkgver")!]);
  expect(values("pkgrel")).toEqual(["1"]);
  expect(values("source")).toEqual(["corkboard.desktop", v.get("source[1]")!]);
  expect(values("sha256sums")).toEqual([v.get("sha256sums[0]")!, v.get("sha256sums[1]")!]);
  expect(values("source_x86_64")).toEqual([v.get("source_x86_64[0]")!]);
  expect(values("sha256sums_x86_64")).toEqual([sha("a")]);
  expect(values("source_aarch64")).toEqual([v.get("source_aarch64[0]")!]);
  expect(values("sha256sums_aarch64")).toEqual([sha("b")]);
  const deps = Bun.spawnSync(["bash", "-c", '. ./PKGBUILD; printf "%s\\n" "${depends[@]}"'], { cwd: join(dir, "packaging/aur/corkboard-bin") }).stdout.toString().trim().split("\n");
  expect(values("depends")).toEqual(deps);
});

test("the AUR package updates from what it wrote, to a release", () => {
  const tarballs = (v: string, a: string, b: string) => [
    { name: `corkboard-${v}-linux-x64.tar.gz`, digest: `sha256:${sha(a)}` },
    { name: `corkboard-${v}-linux-arm64.tar.gz`, digest: `sha256:${sha(b)}` },
  ];
  release("v0.2.0-rc3", tarballs("0.2.0-rc3", "a", "b"));
  expect(update("aur", "0.2.0-rc3").code).toBe(0);
  release("v0.2.0", tarballs("0.2.0", "c", "d"));
  expect(update("aur", "0.2.0")).toMatchObject({ code: 0, out: "corkboard-bin 0.2.0" });
  const v = sourced();
  expect([v.get("pkgver"), v.get("sha256sums_x86_64[0]"), v.get("sha256sums_aarch64[0]")]).toEqual(["0.2.0", sha("c"), sha("d")]);
  expect(v.get("sha256sums[1]")).toBe(sha256("bytes of https://raw.githubusercontent.com/mattjurenka/corkboard/v0.2.0/app/build/icons/512x512.png"));
});

test("a release without both Linux tarballs changes nothing", () => {
  const before = [file("aur/corkboard-bin/PKGBUILD"), file("aur/corkboard-bin/.SRCINFO")];
  release("v0.3.0", [{ name: "corkboard-0.3.0-linux-x64.tar.gz", digest: `sha256:${sha("a")}` }]);
  expect(update("aur", "0.3.0")).toMatchObject({ code: 1, err: "v0.3.0 has no Linux tarballs" });
  // And one that isn't there at all.
  expect(update("aur", "9.9.9").code).not.toBe(0);
  expect([file("aur/corkboard-bin/PKGBUILD"), file("aur/corkboard-bin/.SRCINFO")]).toEqual(before);
});

test("the cask at a release: its version and the dmgs' digests, each arch its own", () => {
  release("v0.2.0", [
    { name: "corkboard-0.2.0-mac-arm64.dmg", digest: `sha256:${sha("e")}` },
    { name: "corkboard-0.2.0-mac-x64.dmg", digest: `sha256:${sha("f")}` },
    { name: "corkboard-0.2.0-linux-x64.tar.gz", digest: `sha256:${sha("a")}` },
  ]);
  const before = file("homebrew/Casks/corkboard.rb");
  expect(update("homebrew", "0.2.0")).toEqual({ code: 0, out: "corkboard 0.2.0", err: "" });
  const cask = file("homebrew/Casks/corkboard.rb");
  expect(cask).toContain(`  version "0.2.0"\n  sha256 arm:   "${sha("e")}",\n         intel: "${sha("f")}"\n`);
  // Nothing else in it moved.
  const rest = (s: string) => s.split("\n").filter((l) => !/^\s+(version|sha256 arm:|intel:) /.test(l));
  expect(rest(cask)).toEqual(rest(before));
  release("v0.3.0", [{ name: "corkboard-0.3.0-mac-arm64.dmg", digest: `sha256:${sha("e")}` }]);
  expect(update("homebrew", "0.3.0")).toMatchObject({ code: 1, err: "v0.3.0 has no Mac dmgs" });
  expect(file("homebrew/Casks/corkboard.rb")).toBe(cask);
});
