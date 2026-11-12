// A brain's thinking (consolidator.ts's brainThink): its model, and its key
// from the hold it names, against an OpenAI-compatible endpoint served here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brainThink, type BrainModel } from "./consolidator";

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
