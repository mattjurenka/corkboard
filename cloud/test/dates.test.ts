import { describe, expect, it } from "vitest";
import { range } from "../src/dates";
import { chunks } from "../src/vectors";

// Tuesday 27 October 2026.
const TODAY = "2026-10-27";
const days = (q: string) => {
  const r = range(q, TODAY);
  return r && [r.from, r.to];
};

describe("the days a question names", () => {
  it("in words", () => {
    expect(days("what did I do today")).toEqual([TODAY, TODAY]);
    expect(days("yesterday's call")).toEqual(["2026-10-26", "2026-10-26"]);
    expect(days("3 days ago")).toEqual(["2026-10-24", "2026-10-24"]);
    expect(days("two weeks ago")).toEqual(["2026-10-12", "2026-10-18"]);
    expect(days("last week")).toEqual(["2026-10-19", "2026-10-25"]);
    expect(days("this week")).toEqual(["2026-10-26", TODAY]);
    expect(days("last month")).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("by weekday: the last one before today", () => {
    expect(days("on monday")).toEqual(["2026-10-26", "2026-10-26"]);
    expect(days("last tuesday")).toEqual(["2026-10-20", "2026-10-20"]);
    expect(days("friday's standup")).toEqual(["2026-10-23", "2026-10-23"]);
  });

  it("by date, this year's unless it's still to come", () => {
    expect(days("the Oct 24 incident")).toEqual(["2026-10-24", "2026-10-24"]);
    expect(days("24th october")).toEqual(["2026-10-24", "2026-10-24"]);
    expect(days("december 3")).toEqual(["2025-12-03", "2025-12-03"]);
    expect(days("2026-10-09")).toEqual(["2026-10-09", "2026-10-09"]);
  });

  it("or none", () => {
    expect(range("how does Baum meter credits", TODAY)).toBeNull();
  });
});

describe("a note in chunks", () => {
  it("is one chunk when short, titled", () => {
    expect(chunks("T", "short")).toEqual(["T\n\nshort"]);
  });

  it("is cut at paragraphs, overlapping, each titled, all of it covered", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`.trim());
    const out = chunks("Title", paras.join("\n\n"));
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) expect(c.startsWith("Title\n\n")).toBe(true);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(1500 + 7);
    for (const p of paras) expect(out.some((c) => c.includes(p))).toBe(true);
  });
});
