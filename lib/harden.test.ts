import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// What runs outside bun's preload (bunfig.toml): compiled, in a Worker, in the page.
const ENTRIES = ["bridge/main.ts", "bridge/server.ts", "mcp/board.ts", "fleet/fleetd/fleetd.ts", "fleet/fleetd/cli.ts", "fleet/guest/acp.ts", "forge/gate/main.ts", "relay/src/index.ts", "web/src/main.tsx", "web/src/phone/main.tsx", "web/src/meet/main.tsx", "web/src/avatar/portrait.ts"];

test("every entry point imports lib/harden before anything else", () => {
  for (const e of ENTRIES) {
    const first = readFileSync(resolve(import.meta.dir, "..", e), "utf8").match(/^(import|await import|export|const|let|async|function|if)\b.*$/m)?.[0];
    expect(`${e}: ${first}`).toMatch(/: import "(\.\.\/)+lib\/harden";$/);
  }
});

test("__proto__ is a key like any other", () => {
  const o: Record<string, unknown> = {};
  o["__proto__"] = { title: "x" };
  const a = Object.assign({}, JSON.parse('{"__proto__":{"title":"x"}}'));
  for (const x of [o, a]) {
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    expect(Object.keys(x)).toEqual(["__proto__"]);
  }
  expect(Object.getPrototypeOf(new Uint8Array(0).constructor.prototype).constructor.name).toBe("TypedArray");
  expect(({} as { __proto__: unknown }).__proto__).toBe(Object.prototype);
});
