import { describe, expect, test } from "bun:test";
import { fuzz } from "../testing/fuzz";
import { range } from "./dates";

// Friday the 20th.
const TODAY = "2026-11-20";

describe("range", () => {
  test.each([
    ["what did I do on 2026-10-24?", "2026-10-24", "2026-10-24", "2026-10-24"],
    ["Today", TODAY, TODAY, "today"],
    ["yesterday", "2026-11-19", "2026-11-19", "yesterday"],
    ["3 days ago", "2026-11-17", "2026-11-17", "3 days ago"],
    ["ten days ago", "2026-11-10", "2026-11-10", "ten days ago"],
    // A week ago is that week, Monday to Sunday.
    ["a week ago", "2026-11-09", "2026-11-15", "a week ago"],
    ["two weeks ago", "2026-11-02", "2026-11-08", "two weeks ago"],
    // A month ago is that month, the whole of it.
    ["a month ago", "2026-10-01", "2026-10-31", "a month ago"],
    ["two months ago", "2026-09-01", "2026-09-30", "two months ago"],
    ["last week", "2026-11-09", "2026-11-15", "last week"],
    // This week and this month go up to today.
    ["this week", "2026-11-16", TODAY, "this week"],
    ["last month", "2026-10-01", "2026-10-31", "last month"],
    ["this month", "2026-11-01", TODAY, "this month"],
    // A weekday is the most recent one before today: a week back, if it is today.
    ["last tuesday", "2026-11-17", "2026-11-17", "last tuesday"],
    ["on Friday", "2026-11-13", "2026-11-13", "on friday"],
    ["saturday", "2026-11-14", "2026-11-14", "saturday"],
    ["Oct 24", "2026-10-24", "2026-10-24", "oct 24"],
    ["october 24th", "2026-10-24", "2026-10-24", "october 24th"],
    ["24 oct.", "2026-10-24", "2026-10-24", "24 oct."],
    ["sept. 3rd", "2026-09-03", "2026-09-03", "sept. 3rd"],
    // One still to come this year is last year's.
    ["dec 25", "2025-12-25", "2025-12-25", "dec 25"],
    ["nov 20", TODAY, TODAY, "nov 20"],
    ["nov 21", "2025-11-21", "2025-11-21", "nov 21"],
    // The first the question names.
    ["yesterday, or last week", "2026-11-19", "2026-11-19", "yesterday"],
  ])("%p", (q, from, to, said) => {
    expect(range(q, TODAY)).toEqual({ from, to, said });
  });

  test("turns over the year", () => {
    expect(range("last month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31", said: "last month" });
    expect(range("1 month ago", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28", said: "1 month ago" });
    expect(range("last week", "2026-01-02")).toEqual({ from: "2025-12-22", to: "2025-12-28", said: "last week" });
    expect(range("jan 3", "2026-01-02")).toEqual({ from: "2025-01-03", to: "2025-01-03", said: "jan 3" });
    expect(range("monday", "2026-11-16")).toEqual({ from: "2026-11-09", to: "2026-11-09", said: "monday" });
  });

  test("names no day it can't tell, nor one that doesn't exist", () => {
    for (const q of ["", "what did we decide?", "constructor days ago", "__proto__ weeks ago", "mayday", "toString month", "2026-1-5"]) expect(range(q, TODAY)).toBeNull();
    // Not another day in its place.
    for (const q of ["feb 30", "oct 45", "0 oct", "31 april", "feb 29"]) expect(range(q, TODAY)).toBeNull();
    expect(range("feb 29", "2028-03-01")).toEqual({ from: "2028-02-29", to: "2028-02-29", said: "feb 29" });
  });

  fuzz("gives days in order, or nothing, for any question", (g) => {
    const words = ["today", "yesterday", "ago", "days", "week", "month", "last", "this", "on", "tuesday", "oct", "24th", "3", "a", "2026-10-24"];
    const q = Array.from({ length: g.size(6) }, () => (g.bool() ? g.pick(words) : g.string())).join(" ");
    const r = range(q, TODAY);
    if (!r) return;
    expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.from <= r.to).toBe(true);
    expect(q.toLowerCase()).toContain(r.said);
  });
});
