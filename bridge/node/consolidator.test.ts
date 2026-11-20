// A consolidation run end to end, as the node does it with no think of its
// own given: the brain's model (lib/think.ts) is an OpenAI-compatible
// endpoint served here, which answers the flush, the page and the rollup
// as a model might, now and then badly. What a bad answer must never do is
// lose the memory or the episode it was reading.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { newRoot } from "../../lib/e2ee/keys";
import { offline } from "../../lib/e2ee/sync";
import { MEMORY_FENCE, MEMORY_MAX, QUIET, SOUL_FENCE } from "../../lib/memory/consolidate";
import { Consolidator } from "./consolidator";
import { Data } from "./data";
import { Episodes } from "./episodes";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";

// The model: what it's asked, and the answer it gives to each kind of prompt.
type Kind = "flush" | "rollup" | "page";
const asked: { kind: Kind; input: string; model: string }[] = [];
const answers: Record<Kind, string | number> = { flush: "", rollup: "", page: "NOTHING" };
let model: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
      const system = body.messages[0].content;
      const kind: Kind = system.includes("memory flush") ? "flush" : system.includes("You compile the page") ? "page" : "rollup";
      asked.push({ kind, input: body.messages[1].content, model: body.model });
      const a = answers[kind];
      if (typeof a === "number") return new Response("overloaded", { status: a });
      return Response.json({ choices: [{ message: { content: a } }] });
    },
  });
});
afterAll(() => model.stop(true));

let replicas: Replicas, data: Data, episodes: Episodes, c: Consolidator;
// A minute past a 4am (UTC) day's turn, behind the real time, as node.test.ts's.
let clock = Math.floor((Date.now() - 4 * 3600_000) / 86_400_000) * 86_400_000 + 4 * 3600_000 + 60_000;
beforeAll(async () => {
  replicas = await Replicas.open({ objects: listObjects(newRoot(), { boards: [], brains: ["assistant"] }), transport: offline, device: "node" });
  await replicas.start({ live: false });
  data = new Data(replicas, "UTC");
  await data.putBrain("assistant", { title: "Assistant", model: `openai:small@http://localhost:${model.port}/v1` });
  episodes = new Episodes();
  c = new Consolidator({ data, episodes, now: () => clock });
});
afterAll(() => replicas.stop());

const said = (text: string) => JSON.stringify({ type: "user", timestamp: new Date(clock).toISOString(), message: { content: [{ type: "text", text }] } }) + "\n";
const failures = () => episodes.meta("assistant", "consolidate_failures");
const memory = () => data.note("assistant", "memory")?.body;
// A run due once what's waiting is quiet, or past the backoff after a failure.
const later = async (ms = QUIET + 1) => {
  clock += ms;
  await c.tick();
};

describe("a consolidation on the brain's own model", () => {
  it("reads an episode into the log, the transcript in the input", async () => {
    episodes.add("assistant", { session: "s1", agent: "assistant", trigger: "end", transcript: said("I use tabs."), project: "corkboard" });
    answers.flush = "- Matthew uses tabs.\n===ITEMS===\nopen agent: Set tabs in the editor config.";
    await later();
    expect(asked.map((a) => [a.kind, a.model])).toEqual([["flush", "small"]]);
    expect(asked[0].input).toContain("I use tabs.");
    expect(data.entries("assistant").map((e) => [e.text, e.project])).toEqual([["Matthew uses tabs.", "corkboard"]]);
    expect(data.items("assistant", "corkboard", true).map((i) => i.text)).toEqual(["Set tabs in the editor config."]);
    expect(episodes.list("assistant", 10, true)).toEqual([]);
  });

  it("keeps an episode the model failed on, and tries it again after the backoff", async () => {
    episodes.add("assistant", { session: "s2", agent: "assistant", trigger: "end", transcript: said("And monospace.") });
    answers.flush = 503;
    await later();
    expect(failures()).toBe("1");
    expect(episodes.list("assistant", 10, true).length).toBe(1);
    // Not within the hour; then read.
    answers.flush = "- Matthew likes monospace.";
    await later(30 * 60_000);
    expect(asked.filter((a) => a.kind === "flush").length).toBe(2);
    await later(31 * 60_000);
    expect(failures()).toBe("0");
    expect(data.entries("assistant").map((e) => e.text)).toContain("Matthew likes monospace.");
  });

  it("writes the memory and compiles the page at the day's turn", async () => {
    answers.rollup = `${MEMORY_FENCE}\n- Uses tabs and monospace.\n${SOUL_FENCE}\nNOTHING`;
    const tabs = data.entries("assistant").find((e) => e.text === "Matthew uses tabs.")!;
    answers.page = `- Tabs, everywhere. [e:${tabs.id}]`;
    await later(86_400_000);
    expect(asked.slice(-2).map((a) => a.kind)).toEqual(["page", "rollup"]);
    expect(memory()).toBe("- Uses tabs and monospace.\n");
    expect(data.note("assistant", "project-corkboard")!.body).toBe(`- Tabs, everywhere. [e:${tabs.id}]\n`);
  });
});

describe("a rollup the model got wrong", () => {
  // A memory long enough to be guarded, a day's log, and its turn. (The
  // log is written as a flush would: an episode is stamped with the real
  // time, and a week on by this clock it would be let go of as old.)
  const day = async (rollup: string | number) => {
    await data.addEntries("assistant", [{ at: new Date(clock).toISOString(), who: "assistant", text: `Day ${clock}.`, key: `day:${clock}` }]);
    answers.rollup = rollup;
    await later(86_400_000);
  };
  const long = Array.from({ length: 60 }, (_, i) => `- Fact ${i}: ${"detail ".repeat(8).trim()}.`).join("\n") + "\n";

  beforeAll(async () => {
    await day(`${MEMORY_FENCE}\n${long}${SOUL_FENCE}\nNOTHING`);
    expect(memory()).toBe(long);
  });

  it.each([
    ["no fence", "- Just bullets, no fence."],
    ["an empty memory", `${MEMORY_FENCE}\n\n${SOUL_FENCE}\nNOTHING`],
    ["an empty code block", `${MEMORY_FENCE}\n\`\`\`\n\`\`\`\n${SOUL_FENCE}\nNOTHING`],
    ["one over the ceiling", `${MEMORY_FENCE}\n${"x".repeat(MEMORY_MAX + 1)}\n${SOUL_FENCE}\nNOTHING`],
    ["most of it thrown away", `${MEMORY_FENCE}\n- Only this.\n${SOUL_FENCE}\nNOTHING`],
    ["the model down", 500],
  ])("leaves the memory as it was: %s", async (_, answer) => {
    const rolled = data.rolled("assistant");
    const was = Number(failures());
    await day(answer);
    expect(memory()).toBe(long);
    expect(data.rolled("assistant")).toBe(rolled);
    expect(Number(failures())).toBe(was + 1);
    // Once the hour's backoff is past, a good answer rolls the day up.
    answers.rollup = `${MEMORY_FENCE}\n${long}- And a day more.\n${SOUL_FENCE}\nNOTHING`;
    await later(3600_000 + 1);
    expect(memory()).toBe(long + "- And a day more.\n");
    expect(failures()).toBe("0");
    expect(data.rolled("assistant")! > rolled!).toBe(true);
    // Back to the memory the next case starts from.
    await data.putNote("assistant", "memory", { kind: "memory", title: "Long-term memory", body: long }, undefined, true);
  });
});
