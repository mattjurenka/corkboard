import { copyFileSync, cpSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `bun run build:meet` writes dist-meet/, corkboard.fyi/meet (src/meet),
// which corkboard-cloud's site/deploy.sh copies into the site. Of public/,
// only what the avatars need: the two models that come with corkboard (the
// rest are on corkboard.fyi already, modelAt), the portraits, and the lines
// said ahead of time and the anime voice's recordings. Each persona has a
// copy of the page at meet/<id> (meet/shirtless.html, served for
// meet/shirtless), which opens on her; at /meet/ only, its files from there.
// meet/phone.html is the phone app's face for a session (src/phone).
const CAST = ["tsundere", "bikini", "businesswoman", "nerd", "businessman", "shirtless", "alien", "diva", "valkyrie"];
const root = fileURLToPath(new URL(".", import.meta.url));
const out = `${root}dist-meet`;
const NEEDED = ["businesswoman.vrm", "businessman.vrm", "personas", "voices/said", "voices/clips"];

export default defineConfig({
  root,
  base: "/meet/",
  publicDir: false,
  plugins: [
    react(),
    // Every line is said ahead, so Kokoro (voice.ts's fallback) never runs
    // here; its ONNX Runtime wasm is over the Worker's 25MB a file.
    {
      name: "no-ort-wasm",
      generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      },
    },
    {
      name: "meet-public",
      closeBundle() {
        for (const p of NEEDED) cpSync(`${root}public/${p}`, `${out}/${p}`, { recursive: true });
        for (const id of CAST) copyFileSync(`${out}/meet.html`, `${out}/${id}.html`);
        renameSync(`${out}/meet.html`, `${out}/index.html`);
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: out, emptyOutDir: true, target: "es2022", rollupOptions: { input: [`${root}meet.html`, `${root}phone.html`] } },
});
