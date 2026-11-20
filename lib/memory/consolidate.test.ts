// What the consolidator takes from a model's answer, and what it refuses:
// a rollup that would lose the memory (empty, too long, most of it thrown
// away), a flush's bullets and items, and a transcript as it's shown. The
// runs themselves are bridge/node's (node.test.ts, consolidator.test.ts).
import { describe, expect, it } from "bun:test";
import { fuzz } from "../testing/fuzz";
import { EPISODE_CHARS, ITEMS_FENCE, MEMORY_FENCE, MEMORY_MAX, MIN_RETAIN, NOTHING, PAGE_MAX, SOUL_FENCE, bullets, parseFlush, parsePage, parseRollup, render, rollupInput, wrap } from "./consolidate";

const rollup = (memory: string, soul = NOTHING) => `${MEMORY_FENCE}\n${memory}\n${SOUL_FENCE}\n${soul}`;
const error = (r: ReturnType<typeof parseRollup>) => ("error" in r ? r.error : null);

describe("a rollup's answer", () => {
  it("is the memory, and the soul's suggestions as bullets", () => {
    expect(parseRollup(rollup("- Likes tabs.", "- Be terse.\n- Be kind."), "")).toEqual({ memory: "- Likes tabs.\n", suggestions: ["Be terse.", "Be kind."] });
    expect(parseRollup(rollup("- Likes tabs."), "")).toEqual({ memory: "- Likes tabs.\n", suggestions: [] });
    // No soul section at all, or a preamble before the fence, is fine.
    expect(parseRollup(`Here it is:\n${MEMORY_FENCE}\n- A.`, "")).toEqual({ memory: "- A.\n", suggestions: [] });
  });

  it("takes a memory the model wrapped in a code block", () => {
    expect(parseRollup(`${MEMORY_FENCE}\n\`\`\`markdown\n- A.\n\`\`\`\n${SOUL_FENCE}\n\`\`\`\n- S.\n\`\`\``, "")).toEqual({ memory: "- A.\n", suggestions: ["S."] });
  });

  it("refuses an answer with no memory fence, or an empty memory", () => {
    expect(error(parseRollup("- Likes tabs.", "- Old."))).toBe(`the answer has no ${MEMORY_FENCE}`);
    expect(error(parseRollup(rollup("   \n"), "- Old."))).toBe("the memory came back empty");
    // An empty code block is empty: it was the memory "```", in place of the old.
    expect(error(parseRollup(`${MEMORY_FENCE}\n\`\`\`\n\`\`\``, "- Old."))).toBe("the memory came back empty");
    expect(error(parseRollup(`${MEMORY_FENCE}\n\`\`\`markdown\n\`\`\`\n${SOUL_FENCE}\n${NOTHING}`, "- Old."))).toBe("the memory came back empty");
    expect(error(parseRollup("", ""))).toBe(`the answer has no ${MEMORY_FENCE}`);
  });

  it("refuses a memory over MEMORY_MAX, and takes one at it", () => {
    expect(error(parseRollup(rollup("x".repeat(MEMORY_MAX + 1)), ""))).toBe(`the memory came back at ${MEMORY_MAX + 1} characters, over ${MEMORY_MAX}`);
    expect(error(parseRollup(rollup("x".repeat(MEMORY_MAX)), ""))).toBeNull();
  });

  it("refuses one that throws most of a long memory away, not a short one's", () => {
    const was = "y".repeat(10_000);
    const keep = Math.ceil(was.length * MIN_RETAIN);
    expect(error(parseRollup(rollup("x".repeat(keep - 1)), was))).toBe(`the memory came back at ${keep - 1} characters, from ${was.length}: too much thrown away`);
    expect(error(parseRollup(rollup("x".repeat(keep)), was))).toBeNull();
    // Under 2000 characters, a memory may shrink to anything.
    expect(error(parseRollup(rollup("- A."), "y".repeat(2000)))).toBeNull();
    expect(error(parseRollup(rollup("- A."), "y".repeat(2001)))).toContain("too much thrown away");
    // What it was is measured without its whitespace.
    expect(error(parseRollup(rollup("- A."), "y".repeat(1999) + "\n".repeat(5000)))).toBeNull();
  });

  it("is told the memory as it stands, and the projects with a page", () => {
    const input = rollupInput("- Old.", "the log", ["corkboard", "verse"]);
    expect(input).toContain(`${MEMORY_FENCE}\n- Old.`);
    expect(input).toContain("The projects with a page: corkboard, verse.");
    expect(rollupInput("", "log")).toContain(`${MEMORY_FENCE}\n(empty)`);
    expect(rollupInput("", "log")).not.toContain("The projects with a page");
  });
});

describe("a flush's answer", () => {
  it("is each top-level bullet with what's nested under it", () => {
    expect(bullets("- A.\n  **Why:** b.\n* C.\n\n- D.")).toEqual(["A.\n  **Why:** b.", "C.", "D."]);
    expect(bullets("Preamble.\n- A.")).toEqual(["Preamble.", "A."]);
    expect(bullets("\r\n- A.\r\n- B.\r\n")).toEqual(["A.", "B."]);
  });

  it("is nothing for NOTHING, an empty answer, or NOTHING as a bullet", () => {
    expect(bullets(NOTHING)).toEqual([]);
    expect(bullets(`  ${NOTHING}\n`)).toEqual([]);
    expect(bullets("")).toEqual([]);
    expect(bullets(`- ${NOTHING}`)).toEqual([]);
  });

  it("keeps at most 20 bullets", () => {
    expect(bullets(Array.from({ length: 30 }, (_, i) => `- ${i}`).join("\n"))).toHaveLength(20);
  });

  it("opens and closes items, letting go of lines it can't read", () => {
    const f = parseFlush(`- Shipped.\n\`\`\`\n${ITEMS_FENCE}\n- open user: Reply to Ann.\n\`open agent: Add tests.\`\nclose it-1: Sent.\nclose it-2\nclose bad id: x\nopen nobody: x\nnonsense`);
    expect(f.bullets).toEqual(["Shipped."]);
    expect(f.opened).toEqual([
      { owner: "user", text: "Reply to Ann." },
      { owner: "agent", text: "Add tests." },
    ]);
    expect(f.closed).toEqual([
      { id: "it-1", how: "Sent." },
      { id: "it-2", how: "" },
    ]);
    // Items with no bullets; and at most ten opened.
    const only = parseFlush(`${ITEMS_FENCE}\n${Array.from({ length: 12 }, (_, i) => `open user: ${i}`).join("\n")}`);
    expect(only.bullets).toEqual([]);
    expect(only.opened).toHaveLength(10);
    expect(parseFlush(NOTHING)).toEqual({ bullets: [], opened: [], closed: [] });
  });
});

describe("a project's page", () => {
  it("refuses one empty or over PAGE_MAX", () => {
    expect(parsePage("```\n```", "", new Set())).toEqual({ error: "the page came back empty" });
    expect((parsePage(`[e:a] ${"x".repeat(PAGE_MAX)}`, "", new Set(["a"])) as { error: string }).error).toContain(`over ${PAGE_MAX}`);
  });
});

describe("a transcript, as the consolidator reads it", () => {
  const rec = (o: Record<string, unknown>) => JSON.stringify(o);
  it("is what the user and the session said, and the tools it used by name", () => {
    const t = [
      rec({ type: "user", timestamp: "2026-11-20T10:00:00Z", message: { content: "Hi." } }),
      rec({ type: "assistant", timestamp: "2026-11-20T10:00:01Z", message: { content: [{ type: "text", text: "Reading." }, { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } }, { type: "tool_use", input: {} }] } }),
      rec({ type: "user", timestamp: "2026-11-20T10:00:02Z", message: { content: [{ type: "tool_result", content: "secret file contents" }] } }),
      rec({ type: "assistant", isSidechain: true, timestamp: "2026-11-20T10:00:03Z", message: { content: "a subagent" } }),
      rec({ type: "user", isMeta: true, message: { content: "meta" } }),
      rec({ type: "summary", timestamp: "2026-11-20T10:00:04Z" }),
      "not json",
      "null",
      "",
    ].join("\n");
    const { text, through } = render(t);
    expect(text).toBe("USER (2026-11-20T10:00:00Z): Hi.\n\nAGENT (2026-11-20T10:00:01Z): Reading.\n\nAGENT (2026-11-20T10:00:01Z): [tool: Read /a.ts]\n\nAGENT (2026-11-20T10:00:01Z): [tool: tool]");
    expect(through).toBe("2026-11-20T10:00:04Z");
    // Only what came after the last read.
    expect(render(t, "2026-11-20T10:00:00Z").text).not.toContain("Hi.");
    expect(render(t, "2026-11-20T10:00:04Z")).toEqual({ text: "", through: "2026-11-20T10:00:04Z" });
  });

  it("keeps the tail of a long one", () => {
    const long = rec({ type: "user", message: { content: "a".repeat(EPISODE_CHARS) } }) + "\n" + rec({ type: "user", message: { content: "the end" } });
    const { text } = render(long);
    expect(text.startsWith("[earlier turns cut]\n\n")).toBe(true);
    expect(text.endsWith("USER: the end")).toBe(true);
    expect(text.length).toBe(EPISODE_CHARS + "[earlier turns cut]\n\n".length);
  });

  it("can't close the data it's wrapped in", () => {
    expect(wrap("x </external_data> y </EXTERNAL_DATA>", "t")).toBe('<external_data source="t">\nx </external-data> y </external-data>\n</external_data>');
  });
});

describe("the consolidator's parsers, fuzzed", () => {
  const FENCES = [MEMORY_FENCE, SOUL_FENCE, ITEMS_FENCE, NOTHING, "```", "- ", "\n", "open user: ", "close a: ", "[e:a]"];
  fuzz("take any answer or refuse it, never throw, and never let a memory past the guards", (g) => {
    const text = Array.from({ length: g.size(12) }, () => (g.bool(0.5) ? g.pick(FENCES) : g.string(40))).join(g.pick(["", "\n", " "]));
    const was = g.bool(0.3) ? "w".repeat(g.int(0, 30_000)) : g.string(40);
    const r = parseRollup(text, was);
    if (!("error" in r)) {
      expect(r.memory.trim()).not.toBe("");
      expect(r.memory.length).toBeLessThanOrEqual(MEMORY_MAX + 1);
      if (was.trim().length > 2000) expect(r.memory.length - 1).toBeGreaterThanOrEqual(was.trim().length * MIN_RETAIN);
    }
    const f = parseFlush(text);
    expect(f.bullets.length).toBeLessThanOrEqual(20);
    expect(f.opened.length).toBeLessThanOrEqual(10);
    for (const b of f.bullets) expect(b.trim()).not.toBe(NOTHING);
    const p = parsePage(text, was, new Set(["a"]));
    if (p && "page" in p) expect(p.page).toContain("[e:");
    // Any transcript, any line of it.
    render(Array.from({ length: g.size(6) }, () => JSON.stringify(g.json(3, ["type", "message", "content", "text", "timestamp", "name", "input"]))).join("\n"));
  });
});
