import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameOf } from "../src/goals";
import { ownerToken, worker } from "./login";

let owner: string;

const call = (method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  owner = await ownerToken();
});
afterEach(async () => {
  await reset();
});

const FITNESS = `**Type:** goal (set 2026-10-24)

## Why
Look **better**. Wants to gain weight.

Second paragraph, not shown.

## Plan
- **3 sessions a week.** The group part also serves [[goal-people]].

## Measured by
- Weekly average bodyweight: **~170 lb by end of Dec**
- Sessions per week (target 3)

## This week (week of 2026-10-26)
- Weigh every morning
- [ ] Start the daily shake
`;

describe("the goals", () => {
  it("splits a title into its name and aim", () => {
    expect(nameOf("Goal: Fitness, gain lean weight and look better (3 sessions/week, eat consistently)")).toEqual([
      "Fitness",
      "gain lean weight and look better (3 sessions/week, eat consistently)",
    ]);
    expect(nameOf("Run a marathon")).toEqual(["Run a marathon", ""]);
  });

  it("reads each goal note into its high-level parts", async () => {
    await call("PUT", "/api/notes/goal-fitness", { kind: "goal", title: "Goal: Fitness, gain lean weight", body: FITNESS });
    await call("PUT", "/api/notes/goal-people", { kind: "goal", title: "Goal: More time with people", body: "## Measured by\nDinners out, one a week. Calls home.\n\nA second line." });
    await call("PUT", "/api/notes/not-a-goal", { kind: "project", title: "Fleet", body: "## Why\nNo." });
    const res = await call("GET", "/api/goals");
    expect(res.status).toBe(200);
    const [fitness, people, ...rest] = await res.json<any[]>();
    expect(rest).toEqual([]);
    expect(fitness).toMatchObject({
      id: "goal-fitness",
      name: "Fitness",
      aim: "gain lean weight",
      why: "Look better. Wants to gain weight.",
      measures: ["Weekly average bodyweight: ~170 lb by end of Dec", "Sessions per week (target 3)"],
      week: ["Weigh every morning", "Start the daily shake"],
      week_of: "2026-10-26",
    });
    expect(people).toMatchObject({ name: "More time with people", aim: "", why: "", measures: ["Dinners out, one a week. Calls home.", "A second line."], week: [] });
    expect(people.week_of).toBeUndefined();
  });

  it("names a linked goal by its name", async () => {
    await call("PUT", "/api/notes/goal-people", { kind: "goal", title: "Goal: More time with people", body: "" });
    await call("PUT", "/api/notes/goal-video", { kind: "goal", title: "Goal: Videos", body: "## Why\nHelps [[goal-people]] and [[goal-gone]], see [the doc](https://x)." });
    const [, video] = await (await call("GET", "/api/goals")).json<any[]>();
    expect(video.why).toBe("Helps More time with people and gone, see the doc.");
  });
});
