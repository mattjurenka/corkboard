import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `bun run build` writes dist/, which the bridge serves. `bun run dev:web`
// serves the page with hot reload and passes the Neovim socket through to a
// bridge on its usual port.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Relative, so the page works where the bridge serves it (/) and where
  // the Worker does (/edit/).
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    // ONNX Runtime's wasm (26MB, over the Worker's 25MB a file) is bundled
    // because its code names it, but transformers.js has it fetched from
    // jsDelivr instead (env.backends.onnx.wasm.wasmPaths).
    {
      name: "no-ort-wasm",
      generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/nvim": { target: "ws://127.0.0.1:7777", ws: true } } },
});
