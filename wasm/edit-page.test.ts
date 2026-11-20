// The page with no machine, as the Worker serves it at /edit/ (edit-page.ts):
// run on a web build, a Neovim build and a plugin made up here, what it
// lays out, the manifest that names it, and the headers that go with it.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { decode } from "@msgpack/msgpack";

const root = mkdtempSync(`${tmpdir()}/edit-page-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (path: string, text: string) => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, text);
};

const web = `${root}/web`;
const nvim = `${root}/nvim-wasm`;
const plugin = `${root}/plugins/corkboard`;
put(`${web}/index.html`, "<!doctype html>");
put(`${web}/assets/app-1234.js`, "console.log(1)");
for (const f of ["nvim.js", "nvim.wasm", "nvim.data"]) put(`${nvim}/${f}`, f);
put(`${plugin}/lua/corkboard/init.lua`, "return {}");
put(`${plugin}/plugin/corkboard.lua`, "-- plugin");
put(`${plugin}/tests/big_test.lua`, "-- left out");
put(`${plugin}/README.md`, "left out");
symlinkSync("corkboard/init.lua", `${plugin}/lua/link.lua`);

const out = `${root}/out`;
const run = (to: string) => Bun.spawnSync(["bun", new URL("./edit-page.ts", import.meta.url).pathname, to, web, nvim, plugin], { stderr: "pipe" });

test("the page, Neovim and its plugins, laid out as a bridge serves them", () => {
  const r = run(out);
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  const edit = `${out}/edit`;
  expect(readFileSync(`${edit}/index.html`, "utf8")).toBe("<!doctype html>");
  expect(existsSync(`${edit}/assets/app-1234.js`)).toBe(true);

  const manifest = JSON.parse(readFileSync(`${edit}/wasm/manifest`, "utf8"));
  expect(manifest).toMatchObject({ rtp: ["corkboard"], cloud: true });
  expect(manifest.wasm).toMatch(/^wasm\/[0-9a-f]{16}\/$/);
  expect(manifest.plugins).toMatch(/^wasm\/plugins\/[0-9a-f]{16}$/);
  for (const f of ["nvim.js", "nvim.wasm", "nvim.data"]) expect(readFileSync(`${edit}/${manifest.wasm}${f}`, "utf8")).toBe(f);

  // Only what Neovim loads of the plugin, links as their targets.
  const plugins = decode(readFileSync(`${edit}/${manifest.plugins}`)) as Record<string, Record<string, [number, Uint8Array | string | null]>>;
  const files = plugins.corkboard;
  expect(Object.keys(plugins)).toEqual(["corkboard"]);
  expect(Object.keys(files).sort()).toEqual(["lua", "lua/corkboard", "lua/corkboard/init.lua", "lua/link.lua", "plugin", "plugin/corkboard.lua"]);
  expect(new TextDecoder().decode(files["lua/corkboard/init.lua"][1] as Uint8Array)).toBe("return {}");
  expect(files["lua/link.lua"]).toEqual([expect.any(Number), "corkboard/init.lua"]);
  expect(files["lua/link.lua"][0] & 0o170000).toBe(0o120000);

  // Isolated, for SharedArrayBuffer; what's versioned kept for good, the manifest never.
  const headers = readFileSync(`${out}/_headers`, "utf8");
  expect(headers).toContain("/edit/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n");
  expect(headers).toContain("/edit/wasm/manifest\n  Cache-Control: no-store\n");
  expect(headers).toContain(`/edit/${manifest.wasm}*\n  Cache-Control: public, max-age=31536000, immutable\n`);
  expect(headers).toContain("/edit/wasm/plugins/*\n  Cache-Control: public, max-age=31536000, immutable\n");
});

test("the same inputs, the same names; a plugin changed, a new one", () => {
  const again = `${root}/again`;
  expect(run(again).exitCode).toBe(0);
  const a = JSON.parse(readFileSync(`${out}/edit/wasm/manifest`, "utf8"));
  const b = JSON.parse(readFileSync(`${again}/edit/wasm/manifest`, "utf8"));
  expect(b).toEqual(a);
  put(`${plugin}/lua/corkboard/init.lua`, "return { changed = true }");
  const changed = `${root}/changed`;
  expect(run(changed).exitCode).toBe(0);
  const c = JSON.parse(readFileSync(`${changed}/edit/wasm/manifest`, "utf8"));
  expect(c.wasm).toBe(a.wasm);
  expect(c.plugins).not.toBe(a.plugins);
});
