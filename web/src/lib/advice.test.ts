// Pepper's usage note: the markdown, and the projects of the JSON it ends
// with, this board's first and the boardless last.
import { describe, expect, test } from "bun:test";
import { parseAdvice } from "./advice";

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
