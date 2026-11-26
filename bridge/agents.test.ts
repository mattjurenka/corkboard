// The agents the page's Agents screen lists (agents.ts): which are on
// PATH, and an installer run for one that isn't, said how it went.

import { afterAll, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, type Run } from "./agents";

const bin = mkdtempSync(join(tmpdir(), "corkboard-agents-"));
const PATH = process.env.PATH;
const HOME = process.env.HOME;
afterAll(() => {
  process.env.PATH = PATH;
  process.env.HOME = HOME;
  rmSync(bin, { recursive: true, force: true });
});
// Nothing of the machine's own: no agent, and no ~/.local/bin to add.
process.env.PATH = bin;
process.env.HOME = bin;

const put = (exe: string) => {
  writeFileSync(join(bin, exe), "#!/bin/sh\n");
  chmodSync(join(bin, exe), 0o755);
};
const call = async (path: string, body?: unknown, run?: Run) => {
  const res = await agents(new Request(`http://x${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), path, run);
  return { status: res.status, ...((await res.json()) as Record<string, any>) } as { status: number } & Record<string, any>;
};
const settled = async () => {
  for (;;) {
    const v = await call("/agents");
    if (!v.installing) return v;
    await Bun.sleep(5);
  }
};

it.skipIf(process.platform === "win32")("lists every kind, none installed, each with where it comes from", async () => {
  const v = await call("/agents");
  expect(v.agents.map((a: any) => [a.name, a.installed])).toEqual([["claude", false], ["codex", false], ["opencode", false], ["agy", false]]);
  expect(v.agents.every((a: any) => a.url.startsWith("https://"))).toBe(true);
  expect(v.agents[0].command).toContain("claude.ai/install.sh");
  // No installer corkboard can run: its website and what it needs.
  expect(v.agents[1]).toMatchObject({ command: null, note: expect.stringContaining("codex-acp") });
  expect(v).toMatchObject({ installing: null, failed: null, path: bin });
});

it.skipIf(process.platform === "win32")("runs a kind's installer, one at a time, and says how it went", async () => {
  expect((await call("/agents/install", { name: "nope" })).status).toBe(400);
  expect(await call("/agents/install", { name: "codex" })).toMatchObject({ status: 400, error: expect.stringContaining("no installer") });

  // One that fails: its last words are kept for the page.
  let release!: () => void;
  const fails: Run = () => new Promise((r) => (release = () => r({ code: 1, output: "curl: could not resolve host\n" })));
  expect(await call("/agents/install", { name: "claude" }, fails)).toMatchObject({ status: 200, installing: "claude" });
  expect(await call("/agents/install", { name: "opencode" }, fails)).toMatchObject({ status: 409 });
  release();
  expect((await settled()).failed).toEqual({ name: "claude", error: "exit 1", output: "curl: could not resolve host" });

  // One that says it worked and left nothing on PATH.
  await call("/agents/install", { name: "claude" }, async () => ({ code: 0, output: "" }));
  expect((await settled()).failed).toMatchObject({ error: "claude still isn't on PATH" });

  // One that works: installed, and the failure before it forgotten.
  const works: Run = async (argv) => {
    expect(argv.at(-1)).toContain("claude.ai/install.sh");
    put("claude");
    return { code: 0, output: "done" };
  };
  await call("/agents/install", { name: "claude" }, works);
  const v = await settled();
  expect(v.failed).toBeNull();
  expect(v.agents.find((a: any) => a.name === "claude").installed).toBe(true);
});
