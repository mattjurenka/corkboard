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
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/nvim": { target: "ws://127.0.0.1:7777", ws: true } } },
});
