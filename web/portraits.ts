// bun run portraits: each persona (src/avatar/personas.ts) drawn on the
// avatar's stage in headless Chromium, to public/personas/<id>.png for the
// brain form. Run again when a persona's model or the stage's look changes.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";
import { PERSONAS } from "./src/avatar/personas";

const root = new URL(".", import.meta.url).pathname;
const out = `${root}public/personas`;
mkdirSync(out, { recursive: true });

const waiting = new Map<string, () => void>();
const server = await createServer({
  configFile: `${root}vite.config.ts`,
  server: { port: 0 },
  plugins: [
    {
      name: "portrait",
      configureServer(s) {
        s.middlewares.use("/__portrait", async (req, res) => {
          const id = new URL(req.url!, "http://x").searchParams.get("persona")!;
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          writeFileSync(`${out}/${id}.png`, Buffer.concat(chunks));
          res.end();
          waiting.get(id)?.();
        });
      },
    },
  ],
});
await server.listen();
const base = server.resolvedUrls!.local[0];

for (const id of Object.keys(PERSONAS)) {
  const done = new Promise<void>((r) => waiting.set(id, r));
  const chrome = Bun.spawn(
    ["chromium", "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", `--user-data-dir=/tmp/corkboard-portraits`, `${base}portrait.html?persona=${id}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  const late = setTimeout(() => console.error(`${id}: nothing after 60s`), 60_000);
  await done;
  clearTimeout(late);
  chrome.kill();
  await chrome.exited;
  console.log(`${out}/${id}.png`);
}
await server.close();
