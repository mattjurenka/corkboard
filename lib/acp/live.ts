// The real agent CLIs, at the versions the flake's nixpkgs has, against
// scripted models (lib/testing/scripted.ts): what each kind's file says was
// verified, checked again on a bump. `bun run test:live` runs it in a nix
// shell with them on PATH; it isn't a *.test.ts, so test:lib leaves it out.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession, type Spec } from "./client";
import { codex } from "./codex";
import { opencode } from "./opencode";
import { chat, PROBE_MCP, responses, type Answer, type Got } from "../testing/scripted";

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

// A home of its own, so the user's config and logins are neither read nor written.
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "acp-live-"));
  homes.push(h);
  return h;
}

type Run = { stop?: string; error?: string; said: string; asked: string[]; got: Got[] };

async function run(spec: Spec, h: string, got: Got[], prompt = "Say hello."): Promise<Run> {
  spec.env = { ...spec.env, HOME: h, CODEX_HOME: h, XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".data"), XDG_STATE_HOME: join(h, ".state"), XDG_CACHE_HOME: join(h, ".cache") };
  const r: Run = { said: "", asked: [], got };
  const s = new AcpSession({
    spec,
    cwd: h,
    dir: join(h, "transcripts"),
    event: () => {},
    update: (u) => {
      if (u.sessionUpdate === "agent_message_chunk") r.said += u.content?.text ?? "";
    },
    permission: async (p) => (r.asked.push(p.tool.title), p.options[0]?.optionId ?? null),
  });
  try {
    await s.start();
    r.stop = await s.prompt(prompt);
  } catch (err) {
    r.error = (err as Error).message;
  } finally {
    s.close();
  }
  return r;
}

describe("codex-acp", () => {
  const codexRun = async (answer: (req: Got, n: number) => Answer) => {
    const m = responses(answer);
    try {
      return await run(codex({ prompt: "Be brief.", model: { provider: "openai", model: "fake-model", base: m.base }, key: "sk-test" }), home(), m.got);
    } finally {
      m.stop();
    }
  };

  test("a turn on the brain's model through the gateway", async () => {
    const r = await codexRun(() => ({ text: "Hello from the scripted model." }));
    expect(r).toMatchObject({ stop: "end_turn", said: "Hello from the scripted model." });
    expect(r.got.find((g) => g.path.endsWith("/responses"))?.model).toBe("fake-model");
  });

  test("the provider's error fails the prompt", async () => {
    const r = await codexRun(() => ({ status: 400, error: { message: "The model `fake-model` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }));
    expect(r.error).toContain("The model `fake-model` does not exist");
  });

  test("a stream that keeps failing fails the prompt, after its retries", async () => {
    const r = await codexRun(() => ({ failed: "The upstream provider failed." }));
    expect(r.error).toContain("The upstream provider failed.");
  });

  test("request_user_input isn't the model's", async () => {
    const r = await codexRun((req, n) =>
      n === 0 ? { call: "request_user_input", args: { questions: [{ id: "c", header: "Color", question: "Which?", options: [{ label: "Red", description: "warm" }] }] } } : { text: JSON.stringify(req.body.input.at(-1)) },
    );
    expect(r.said).toContain("request_user_input is unavailable");
  });
});

describe("opencode", () => {
  const ocRun = async (answer: (req: Got, n: number) => Answer, extra: object = {}) => {
    const m = chat(answer);
    try {
      const h = home();
      const spec = opencode({ dir: h, name: "live", mcp: [JSON.stringify({ mcpServers: { probe: { command: "bun", args: [PROBE_MCP] } } })], model: { provider: "openai", model: "m", base: m.base } });
      const config = { ...JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT), ...extra };
      spec.env = { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
      return await run(spec, h, m.got);
    } finally {
      m.stop();
    }
  };
  // Its title is a request of its own, with no tools.
  const turns = (r: Run) => r.got.filter((g) => g.path.endsWith("/chat/completions") && g.tools.length);

  test("the MCP servers' tools are the model's on the first prompt", async () => {
    const r = await ocRun(() => ({ text: "hi" }));
    expect(r.stop).toBe("end_turn");
    expect(turns(r)[0]?.tools).toContain("probe_ping");
  });

  test("a `permission` of ask asks corkboard", async () => {
    const r = await ocRun((req) => (req.tools.length && !JSON.stringify(req.body.messages).includes("tool_call_id") ? { call: "bash", args: { command: "echo hi", description: "Say hi" } } : { text: "done" }), { permission: { bash: "ask" } });
    expect(r.asked).toEqual(["echo hi"]);
  });
});
