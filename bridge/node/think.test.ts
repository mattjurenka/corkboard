// A brain's thinking (consolidator.ts's brainThink, app.ts's brains_think)
// and its sessions' environment (brains_session): its model, and its key
// from the hold it names, against an OpenAI-compatible endpoint served here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brains as op } from "./app";
import { brainThink, type BrainModel } from "./consolidator";
import type { StartedNode } from "./serve";

describe("brainThink", () => {
  let server: ReturnType<typeof Bun.serve>;
  const asked: { auth: string | null; model: string }[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string };
        asked.push({ auth: req.headers.get("authorization"), model: body.model });
        return Response.json({ choices: [{ message: { content: `- read by ${body.model}` } }] });
      },
    });
  });
  afterAll(() => server.stop(true));

  const brains: Record<string, BrainModel> = {};
  const holds: Record<string, string> = { "openrouter-key": "sk-or-1" };
  const think = brainThink((b) => brains[b], (h) => holds[h]);

  test("its model, with its hold's secret as the key", async () => {
    brains.work = { model: `openai:small@http://localhost:${server.port}/v1`, model_key: "openrouter-key" };
    expect(await think("prompt", "input", "work")).toBe("- read by small");
    expect(asked.at(-1)).toEqual({ auth: "Bearer sk-or-1", model: "small" });
  });

  test("a model with no key", async () => {
    brains.local = { model: `openai:llama@http://localhost:${server.port}/v1` };
    expect(await think("prompt", "input", "local")).toBe("- read by llama");
    expect(asked.at(-1)!.auth).toBeNull();
  });

  test("a key whose hold has no secret here", async () => {
    brains.lost = { model: `openai:x@http://localhost:${server.port}/v1`, model_key: "gone" };
    await expect(think("prompt", "input", "lost")).rejects.toThrow("gone, has no secret");
  });
});

describe("brains_session and brains_think", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: '{"items":["a"]}' } }] }) });
  });
  afterAll(() => server.stop(true));

  const list: (BrainModel & { name: string })[] = [];
  const holds: Record<string, string> = { "or-key": "sk-or-2" };
  const n = {
    data: { brains: () => list, defaultBrain: () => list[0]?.name },
    sealed: { secrets: (names: string[]) => Object.fromEntries(names.filter((h) => holds[h]).map((h) => [h, holds[h]])) },
  } as unknown as StartedNode;

  test("the default brain's session, on its endpoint, the key from its hold", async () => {
    list.push({ name: "pepper", model: "openrouter:z-ai/glm-4.6", model_key: "or-key" }, { name: "plain", model: null });
    const got = (await op(n, "brains_session", [null])) as { env: Record<string, string>; model: string };
    expect(got.model).toBe("z-ai/glm-4.6");
    expect(got.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-2");
    expect(await op(n, "brains_session", ["plain"])).toEqual({ env: {}, model: null });
  });

  test("what can't run is Invalid", async () => {
    list.push({ name: "openai", model: "openai:gpt-5.1" }, { name: "lost", model: "ollama:x", model_key: "gone" });
    await expect(op(n, "brains_session", ["openai"])).rejects.toThrow("openai: Claude Code can't run on OpenAI's API");
    await expect(op(n, "brains_session", ["lost"])).rejects.toThrow("lost: its model_key, gone, has no secret");
    await expect(op(n, "brains_session", ["nobody"])).rejects.toThrow("no brain nobody");
  });

  test("a thought on the brain's model, to a schema", async () => {
    list.push({ name: "local", model: `openai:small@http://localhost:${server.port}/v1` });
    const schema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] };
    expect(await op(n, "brains_think", ["local", { system: "s", input: "i", schema }])).toEqual({ text: '{"items":["a"]}', json: { items: ["a"] } });
    await expect(op(n, "brains_think", ["local", { system: "s" }])).rejects.toThrow("think needs a system and an input");
  });
});
