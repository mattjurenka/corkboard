// Neovim's worker calling the machine's (link.ts): a real Worker blocks in
// call() while this thread answers, slowly and in order, through a real
// MessageChannel and shared memory.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { answer } from "./link";

const dir = mkdtempSync(`${tmpdir()}/link-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A worker that makes the calls it's sent, one after another, blocking on
// each, and posts back what came of them.
const worker = `${dir}/caller.ts`;
writeFileSync(
  worker,
  `import { caller } from ${JSON.stringify(new URL("./link.ts", import.meta.url).pathname)};
let link;
self.onmessage = ({ data }) => {
  if (data.port) return void (link = caller(data.port, data.reply));
  const out = [];
  for (const [kind, path, body] of data.calls) {
    try {
      if (kind === "send") link.send(path, new Uint8Array(body));
      else out.push([...link.call(path, new Uint8Array(body))]);
    } catch (e) {
      out.push(String(e.message));
    }
  }
  postMessage(out);
};`,
);

function start(handle: (path: string, body: Uint8Array) => Uint8Array | Promise<Uint8Array>, size?: number) {
  const w = new Worker(worker);
  const { port1, port2 } = new MessageChannel();
  const reply = new SharedArrayBuffer(size ?? 1 << 16);
  answer(port1, reply, handle);
  w.postMessage({ port: port2, reply }, [port2]);
  const run = (calls: [kind: "call" | "send", path: string, body: number[]][]) =>
    new Promise<unknown[]>((ok) => {
      w.onmessage = (e) => ok(e.data);
      w.postMessage({ calls });
    });
  return { run, stop: () => (port1.close(), w.terminate()) };
}

test("each call is answered while the caller waits, in order, sends among them", async () => {
  const seen: string[] = [];
  const { run, stop } = start(async (path, body) => {
    seen.push(`${path}:${[...body]}`);
    // Answers that take a while, the first longest.
    await new Promise((r) => setTimeout(r, path === "a" ? 30 : 1));
    return new Uint8Array([...body].map((b) => b * 2));
  });
  try {
    expect(
      await run([
        ["call", "a", [1, 2]],
        ["send", "s", [7]],
        ["call", "b", [3]],
        ["call", "c", []],
      ]),
    ).toEqual([[2, 4], [6], []]);
    expect(seen).toEqual(["a:1,2", "s:7", "b:3", "c:"]);
  } finally {
    stop();
  }
});

test("an answer too big for the reply buffer is an error to the caller, and the next call still works", async () => {
  const { run, stop } = start((path) => new Uint8Array(path === "big" ? 64 : 4).fill(1), 8 + 32);
  try {
    expect(
      await run([
        ["call", "big", []],
        ["call", "small", []],
      ]),
    ).toEqual(["big: the answer was too big", [1, 1, 1, 1]]);
  } finally {
    stop();
  }
});
