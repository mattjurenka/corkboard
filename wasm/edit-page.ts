// The page the Worker serves at /edit/ (cloud/wrangler.jsonc's assets): a
// page with no machine. The web build, Neovim compiled to wasm and the
// plugins' files, laid out as a bridge serves them (bridge/server.ts's
// /wasm/), with a manifest saying the page's own origin is the Worker, and
// the headers that let the page share memory with its workers.
//
//   bun wasm/edit-page.ts <out> <web dist> <nvim-wasm's lib/nvim-wasm> <plugin dir>...

import { cpSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bundle } from "../bridge/wasm";

const [out, web, nvim, ...plugins] = process.argv.slice(2);
const edit = `${out}/edit`;
mkdirSync(edit, { recursive: true });
cpSync(web, edit, { recursive: true });

// Versioned as the bridge versions them, so the browser keeps them for good.
const version = createHash("sha256").update(realpathSync(nvim)).digest("hex").slice(0, 16);
mkdirSync(`${edit}/wasm/${version}`, { recursive: true });
for (const f of ["nvim.js", "nvim.wasm", "nvim.data"]) cpSync(`${nvim}/${f}`, `${edit}/wasm/${version}/${f}`);

const { names, bytes } = bundle(plugins);
const key = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
mkdirSync(`${edit}/wasm/plugins`, { recursive: true });
writeFileSync(`${edit}/wasm/plugins/${key}`, bytes);
writeFileSync(`${edit}/wasm/manifest`, JSON.stringify({ wasm: `wasm/${version}/`, plugins: `wasm/plugins/${key}`, rtp: names, cloud: true }));

// Cross-origin isolation, for SharedArrayBuffer; what's versioned, kept.
writeFileSync(
  `${out}/_headers`,
  `/edit/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
/edit/wasm/manifest
  Cache-Control: no-store
/edit/assets/*
  Cache-Control: public, max-age=31536000, immutable
/edit/wasm/plugins/*
  Cache-Control: public, max-age=31536000, immutable
/edit/wasm/${version}/*
  Cache-Control: public, max-age=31536000, immutable
`,
);
