// The node's embedder on its real model (embed.ts's bge), which test:live
// runs, as it needs the model (downloaded once, about 34 MB) and minutes:
// batches of every size and length leave the process about where one
// batch did. With onnxruntime's arena and memory patterns, 40 such
// batches took it from 720 MB to 2.3 GB.
import { expect, test } from "bun:test";
import { bge } from "./embed";

test("embedding batches of every shape doesn't grow the process", async () => {
  const word = () => Math.random().toString(36).slice(2, 2 + Math.ceil(Math.random() * 8));
  const text = () => Array.from({ length: 20 + Math.floor(Math.random() * 300) }, word).join(" ");
  const batch = () => bge(Array.from({ length: 1 + Math.floor(Math.random() * 32) }, text));
  const rss = () => (Bun.gc(true), process.memoryUsage().rss);
  for (let i = 0; i < 3; i++) await batch();
  const after = rss();
  for (let i = 0; i < 30; i++) await batch();
  expect((rss() - after) / 1e6).toBeLessThan(200);
}, 600_000);
