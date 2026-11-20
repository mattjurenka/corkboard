// What a card waits on the user for: its question first, then its
// permission prompt, then its review.
import { expect, test } from "bun:test";
import { type BoardCard, yourTurn } from "./Board";

const card = (c: Partial<BoardCard>): BoardCard => ({ id: "1", title: "t", status: "working", ...c });

test("yourTurn", () => {
  expect(yourTurn(card({}))).toBeUndefined();
  expect(yourTurn(card({ attention: "Which one?" }))).toBe("answer");
  expect(yourTurn(card({ session: "permission" }))).toBe("session");
  expect(yourTurn(card({ attention: "Which one?", session: "permission" }))).toBe("answer");
  expect(yourTurn(card({ status: "review", agent_state: "needs-review" }))).toBe("review");
  expect(yourTurn(card({ status: "review", agent_state: "needs-review", review: { state: "passed" } }))).toBe("review");
  expect(yourTurn(card({ status: "review", agent_state: "needs-review", review: { state: "failed" } }))).toBe("review");
  expect(yourTurn(card({ status: "review", agent_state: "needs-review", session: "permission" }))).toBe("session");
  // Not while the reviewer is still at it, nor before it's asked for.
  expect(yourTurn(card({ status: "review", agent_state: "needs-review", review: { state: "reviewing" } }))).toBeUndefined();
  expect(yourTurn(card({ status: "review", agent_state: "working" }))).toBeUndefined();
  expect(yourTurn(card({ status: "working", agent_state: "needs-review" }))).toBeUndefined();
  // An empty question is none.
  expect(yourTurn(card({ attention: "" }))).toBeUndefined();
  for (const session of ["starting", "working", "background", "ready", "idle", "exited"] as const) expect(yourTurn(card({ session }))).toBeUndefined();
});
