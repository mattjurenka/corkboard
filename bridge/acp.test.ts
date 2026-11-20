// What an ACP agent says on stderr reaches Neovim when it fails to start:
// on the exit, for one whose process ended, and on acp_start's error, for
// one still running. The kinds are stand-ins written in sh.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "corkboard-acp-"));
process.env.CORKBOARD_STATE_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { Acp } = await import("./acp");

const sh = (script: string) => () => ({ command: ["sh", "-c", script] });
const KINDS = {
  // codex-acp without a key: why on stderr, then out.
  gone: sh("echo starting >&2; echo 'Authentication required' >&2; exit 1"),
  // One that refuses initialize and stays up.
  refuses: sh(`echo 'no key in the environment' >&2; read l; echo '{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"Authentication required"}}'; sleep 10`),
};

function acp(kinds: Record<string, () => { command: string[] }> = KINDS) {
  const calls: { code: string; args: unknown[] }[] = [];
  const a = new Acp((code, ...args) => calls.push({ code, args }), () => undefined, kinds);
  return { a, calls };
}

test("one that exits: its stderr with the exit", async () => {
  const { a, calls } = acp();
  const err = (await a.call("acp_start", [1, { kind: "gone", cwd: dir }]).catch((e) => e)) as Error;
  expect(err.message).toBe("sh exited with status 1");
  const exited = calls.find((c) => c.code.includes("exited"));
  expect(exited?.args).toEqual([1, 1, "starting\nAuthentication required\n"]);
});

test("one that refuses and stays: its stderr with the error", async () => {
  const { a, calls } = acp();
  const err = (await a.call("acp_start", [2, { kind: "refuses", cwd: dir }]).catch((e) => e)) as Error;
  expect(err.message).toBe("Authentication required\nno key in the environment");
  a.close();
  // Stopped, so a signal's exit and no status.
  await new Promise((r) => setTimeout(r, 300));
  expect(calls.find((c) => c.code.includes("exited"))?.args.slice(0, 2)).toEqual([2, null]);
});

test("only the end of a long stderr is kept", async () => {
  const { a, calls } = acp({ long: sh("i=0; while [ $i -lt 400 ]; do echo line $i is here >&2; i=$((i+1)); done; exit 3") });
  await a.call("acp_start", [3, { kind: "long", cwd: dir }]).catch(() => {});
  const stderr = calls.find((c) => c.code.includes("exited"))?.args[2] as string;
  expect(stderr.length).toBe(4096);
  expect(stderr.endsWith("line 399 is here\n")).toBe(true);
});
