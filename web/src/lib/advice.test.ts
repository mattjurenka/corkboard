// Pepper's usage note: the markdown, and the projects of the JSON it ends
// with, this board's first and the boardless last.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { type ProjectAdvice, parseAdvice } from "./advice";

const note = (json: unknown, before = "# Usage\n\nSome notes.\n\n") => `${before}\`\`\`json\n${typeof json === "string" ? json : JSON.stringify(json)}\n\`\`\`\n`;

describe("parseAdvice", () => {
  test("a note with no JSON is its markdown", () => {
    expect(parseAdvice("# Usage\n\nNothing to say.")).toEqual({ markdown: "# Usage\n\nNothing to say." });
    expect(parseAdvice("")).toEqual({ markdown: "" });
  });

  test("the projects, and the markdown before them", () => {
    const r = parseAdvice(note({ projects: [{ project: "a", recommendations: [{ title: "t", saving: 2 }] }] }));
    expect(r.markdown).toBe("# Usage\n\nSome notes.\n\n");
    expect(r.projects?.map((p) => p.project)).toEqual(["a"]);
    expect(r.projects?.[0].recommendations?.[0]).toMatchObject({ title: "t", saving: 2 });
  });

  test("this board's first, then the others with a board, then those without", () => {
    const projects = [{ project: "none" }, { project: "other", board: "x" }, { project: "mine", board: "y" }, { project: "none2", board: null }];
    expect(parseAdvice(note({ projects }), "y").projects?.map((p) => p.project)).toEqual(["mine", "other", "none", "none2"]);
    expect(parseAdvice(note({ projects })).projects?.map((p) => p.project)).toEqual(["other", "mine", "none", "none2"]);
  });

  test("only a fence that ends the note is the JSON, trailing space aside", () => {
    expect(parseAdvice(note({ projects: [{ project: "a" }] }) + "\n  \n").projects).toHaveLength(1);
    const middle = "```json\n{\"projects\":[{\"project\":\"a\"}]}\n```\n\nMore after.";
    expect(parseAdvice(middle)).toEqual({ markdown: middle });
  });

  test("JSON that isn't, or has no projects, leaves the markdown without it", () => {
    for (const json of ["{not json", "null", "[]", '"projects"', "{}", '{"projects":{}}', '{"projects":[]}', '{"projects":[null,1,"a",{"project":5},{}]}'])
      expect(parseAdvice(note(json))).toEqual({ markdown: "# Usage\n\nSome notes.\n\n" });
  });

  test("a project named like an Object method is a project", () => {
    const r = parseAdvice(note({ projects: [{ project: "constructor", board: "__proto__" }, { project: "toString" }] }), "__proto__");
    expect(r.projects?.map((p) => p.project)).toEqual(["constructor", "toString"]);
  });
});

// The usage view renders what this gives it with no guard (recs.reduce,
// md(r.change)), and a throw there takes the page down: a model's note with
// recommendations of {} or a saving of "5" did.
const shaped = (p: ProjectAdvice) => {
  expect(typeof p.project).toBe("string");
  expect(p.board === null || p.board === undefined || typeof p.board === "string").toBe(true);
  for (const list of [p.recommendations, p.earlier]) expect(list === undefined || Array.isArray(list)).toBe(true);
  for (const r of p.recommendations ?? []) {
    expect(typeof r.title).toBe("string");
    if (r.saving !== undefined) expect(Number.isFinite(r.saving)).toBe(true);
    for (const f of [r.change, r.evidence]) expect(f === undefined || typeof f === "string").toBe(true);
    if (r.cards !== undefined) expect(r.cards.every((c) => typeof c === "string")).toBe(true);
  }
  for (const e of p.earlier ?? []) for (const f of [e.title, e.status, e.evidence]) expect(f === undefined || typeof f === "string").toBe(true);
};

test("each field is kept only as the type the view takes", () => {
  const r = parseAdvice(
    note({
      projects: [
        { project: "a", board: 7, recommendations: {}, earlier: "none" },
        { project: "b", recommendations: [null, 1, "x", [], { title: 5, saving: "5", change: { a: 1 }, evidence: ["e"], cards: [1, "c"] }], earlier: [null, { title: "t", status: 2 }] },
      ],
    }),
  );
  expect(r.projects).toEqual([
    { project: "a", board: null, recommendations: [], earlier: [] },
    {
      project: "b",
      board: null,
      recommendations: [{ title: "", saving: undefined, change: undefined, evidence: undefined, cards: ["c"] }],
      earlier: [{ title: "t", status: undefined, evidence: undefined }],
    },
  ]);
});

fuzz("parseAdvice's projects are always of the view's shape", (g) => {
  const keys = ["projects", "project", "board", "recommendations", "earlier", "title", "saving", "change", "evidence", "cards", "status"];
  const project = () => (g.bool(0.8) ? { project: g.bool(0.8) ? g.string() : g.json(1, keys), ...(g.json(3, keys) as object) } : g.json(2, keys));
  const json = { projects: g.bool(0.9) ? Array.from({ length: g.size(5) }, project) : g.json(2, keys) };
  for (const p of parseAdvice(note(json), g.string()).projects ?? []) shaped(p);
}, { runs: 500 });
