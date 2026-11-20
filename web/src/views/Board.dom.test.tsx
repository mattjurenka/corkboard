// The board drawn from corkboard.board's state: its columns and cards, what
// each card says, the cards waiting on you, and what a click asks Neovim.
import "@/testing/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { byText, cleanup, click, fakeNvim, one, render, settle } from "@/testing/render";
import { Board, type BoardCard } from "./Board";
import { Cards } from "./Cards";

afterEach(cleanup);

const card = (c: Partial<BoardCard> & { id: string }): BoardCard => ({ title: `card ${c.id}`, status: "todo", ...c });
const STATE = {
  statuses: ["todo", "doing", "review", "done"],
  selected: "c-2",
  cards: [
    card({ id: "c-1", priority: "high" }),
    card({ id: "c-2", status: "doing", agent: "claude", agent_state: "working", session: "working", cost: { cost: 1.5, tokens: 10, sessions: 1 } }),
    card({ id: "c-3", status: "doing", attention: "Which one?", waiting: [{ id: "c-1", missing: false }, { id: "c-9", missing: true }] }),
    card({ id: "c-4", status: "review", agent_state: "needs-review", review: { state: "passed", risk: "low", summary: "Looks fine" } }),
    card({ id: "c-5", status: "doing", session: "permission", cost: { tokens: 5, sessions: 2 } }),
    card({ id: "c-6", status: "review", review: { state: "reviewing" }, writing: true }),
    card({ id: "c-7", status: "review", review: { state: "failed", problems: ["a", "b"] }, session: "exited" }),
  ],
};

function mount(state: object = STATE, focused = true) {
  const n = fakeNvim();
  return { ...n, ...render(<Board state={state as never} win={4} buf={2} focused={focused} nvim={n.nvim} />) };
}
// A column by its heading's status (the count beside it in a span of its own).
const column = (el: HTMLElement, status: string) =>
  [...el.querySelectorAll<HTMLElement>("section")].find((s) => s.querySelector("h2")?.firstChild?.textContent?.trim() === status)!;
const cardsIn = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>("[data-slot=card]")];
const cardOf = (section: HTMLElement, title: string) => cardsIn(section).find((c) => c.textContent!.includes(title))!;

describe("Board", () => {
  test("a column for each status with its count, a dash in an empty one", () => {
    const { el } = mount();
    const counts = STATE.statuses.map((s) => column(el, s).querySelector("h2")!.textContent);
    expect(counts).toEqual(["todo 1", "doing 3", "review 3", "done 0"]);
    expect(cardsIn(column(el, "doing")).map((c) => c.querySelector("div")!.textContent)).toEqual(["card c-2", "card c-3", "card c-5"]);
    expect(column(el, "done").querySelector(".text-border")!.textContent).toBe("—");
  });

  test("the selected card marked, its column lit while the board has focus", () => {
    const { el, rerender, nvim } = mount();
    const selected = el.querySelectorAll("[data-selected]");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("card c-2");
    expect(column(el, "doing").querySelector("h2")!.className).toContain("text-focus");
    expect(column(el, "todo").querySelector("h2")!.className).not.toContain("text-focus");
    rerender(<Board state={STATE as never} win={4} buf={2} focused={false} nvim={nvim} />);
    expect(column(el, "doing").querySelector("h2")!.className).not.toContain("text-focus");
  });

  test("what a card says: number, priority, agent, session, cost, review, question, what it waits on", () => {
    const { el } = mount();
    const doing = column(el, "doing");
    const two = cardOf(doing, "card c-2");
    expect(two.querySelector("span")!.textContent).toBe("● 2");
    expect(two.textContent).toContain("claude · working");
    expect(two.textContent).toContain("⏵ running");
    expect(two.textContent).toContain("$1.50 · 1 session");
    expect(cardOf(column(el, "todo"), "card c-1").querySelector("span")!.textContent).toBe("● 1 high");
    expect(cardOf(doing, "card c-5").textContent).toContain("— · 2 sessions");
    expect(cardOf(doing, "card c-5").textContent).toContain("⏵ asking permission");
    const three = cardOf(doing, "card c-3");
    expect(three.textContent).toContain("! Which one? ↩ go to it");
    expect(three.textContent).toContain("└─ waits on c-1, c-9?");
    expect(one(three, "span", "c-9?").title).toBe("No such card");
    const review = column(el, "review");
    expect(cardOf(review, "card c-4").textContent).toContain("✓ low risk");
    expect(cardOf(review, "card c-4").textContent).toContain("Looks fine");
    expect(cardOf(review, "card c-4").textContent).toContain("agent · needs review");
    expect(cardOf(review, "card c-6").textContent).toContain("◆ reviewing");
    expect(cardOf(review, "card c-6").textContent).toContain("✎ writing it up");
    expect(cardOf(review, "card c-7").textContent).toContain("✗ 2 problems");
    expect(cardOf(review, "card c-7").textContent).toContain("⏵ session ended");
  });

  test("a click selects the card in Neovim, then opens it", async () => {
    const { el, take } = mount();
    click(cardOf(column(el, "todo"), "card c-1"));
    await settle();
    expect(take()).toEqual([
      ["board.select", "c-1", 4],
      ["board.action", "open", 4],
    ]);
  });

  test("its session line goes to the session and its question to the question, not opening the card", async () => {
    const { el, take } = mount();
    const doing = column(el, "doing");
    click(one(cardOf(doing, "card c-2"), "div", "⏵ running"));
    await settle();
    expect(take()).toEqual([
      ["board.select", "c-2", 4],
      ["board.action", "session", 4],
    ]);
    click(one(cardOf(doing, "card c-3"), "span", "↩ go to it"));
    await settle();
    expect(take()).toEqual([
      ["board.select", "c-3", 4],
      ["board.action", "answer", 4],
    ]);
    // An ended session is only the card's.
    const seven = cardOf(column(el, "review"), "card c-7");
    expect(one(seven, "div", "⏵ session ended").title).toBe("");
    click(one(seven, "div", "⏵ session ended"));
    await settle();
    expect(take()).toEqual([
      ["board.select", "c-7", 4],
      ["board.action", "open", 4],
    ]);
  });

  test("your turn: the question first, then the permission prompt, then the review, each clicked to it", async () => {
    const { el, take } = mount();
    const turn = [...el.querySelectorAll("section")].find((s) => s.querySelector("h2")!.textContent!.startsWith("your turn"))!;
    expect(turn.querySelector("h2")!.textContent).toBe("your turn 3");
    expect(cardsIn(turn).map((c) => c.querySelector("div")!.textContent)).toEqual(["card c-3", "card c-5", "card c-4"]);
    // Not selected there, though selected in its column.
    for (const [i, act] of ["answer", "session", "review"].entries()) {
      click(cardsIn(turn)[i]);
      await settle();
      expect(take()[1]).toEqual(["board.action", act, 4]);
    }
  });

  test("none waiting, no your turn", () => {
    const { el } = mount({ ...STATE, cards: STATE.cards.filter((c) => !["c-3", "c-4", "c-5"].includes(c.id)) });
    expect(el.textContent).not.toContain("your turn");
  });

  test("each key along the bottom is its action", () => {
    const { el, take } = mount();
    const keys = [...el.querySelectorAll<HTMLButtonElement>("button[title]")];
    expect(keys.map((k) => k.title)).toContain("Archive (x)");
    click(keys.find((k) => k.title === "Archive (x)")!);
    click(keys.find((k) => k.title === "New card (o)")!);
    expect(take()).toEqual([
      ["board.action", "archive", 4],
      ["board.action", "new", 4],
    ]);
  });

  test("no board at home: the way to the projects", () => {
    const { el, take } = mount({ none: true, statuses: [], cards: [] });
    expect(el.textContent).toBe("→ Projects");
    click(el.querySelector("button")!);
    expect(take()).toEqual([["projects.show"]]);
  });

  test("states and sessions from Neovim it doesn't know, the prototype's names among them, are shown as they are", () => {
    const odd = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    const { el } = mount({
      statuses: ["todo"],
      cards: odd.map((s, i) => card({ id: `x-${i}`, agent_state: s, session: s as never, priority: s as never, review: { state: "passed", risk: s } })),
    });
    const cards = cardsIn(column(el, "todo"));
    for (const [i, s] of odd.entries()) {
      expect(cards[i].textContent).toContain(`agent · ${s}`);
      expect(cards[i].textContent).toContain(`⏵ ${s}`);
      expect(cards[i].textContent).toContain(`✓ ${s} risk`);
      expect(cards[i].innerHTML).not.toContain("function");
      expect(cards[i].innerHTML).not.toContain("[object");
    }
  });
});

// The cards beside a session (corkboard.claude.cards), drawn as the board's.
describe("Cards", () => {
  const mountCards = (state: object) => {
    const n = fakeNvim();
    return { ...n, ...render(<Cards state={state as never} win={4} buf={6} focused nvim={n.nvim} />) };
  };

  test("this session's cards, then those ready to work on, a dash for none", () => {
    const { el } = mountCards({ mine: [card({ id: "c-1" })], selected: "c-1" });
    expect([...el.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["this session 1", "ready to work on 0"]);
    expect(el.querySelector("[data-selected]")!.textContent).toContain("card c-1");
    expect(byText(el, "div.text-border", "—")).toHaveLength(1);
  });

  test("a click opens the card beside the session; its session line and question go to them", () => {
    const { el, take } = mountCards({ open: [card({ id: "c-2", session: "idle", attention: "?" })] });
    const c = el.querySelector<HTMLElement>("[data-slot=card]")!;
    click(c);
    click(one(c, "div", "⏵ idle"));
    click(one(c, "span", "↩ go to it"));
    expect(take()).toEqual([
      ["claude.cards.open", "c-2", 6],
      ["claude.cards.go", "c-2"],
      ["claude.cards.go", "c-2"],
    ]);
  });
});
