import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rpc, setup, toolText } from "./testing";

// The card tools an agent ends its turn with, the notes and brains it
// reads, and the budget guard, over the node's /mcp.
describe("a card's agent asking, giving up and finishing, over the node's MCP", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  let token: string;
  beforeAll(async () => {
    n = await setup();
    token = n.oauth.mint("test", 1, "assistant");
  });
  afterAll(() => n.stop());
  const tool = async (name: string, args: Record<string, unknown>, as = token) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, as)));
  const json = async (name: string, args: Record<string, unknown>) => {
    const r = await tool(name, args);
    if (r.error) throw new Error(r.text);
    return JSON.parse(r.text);
  };
  const made = async (title: string) => (await n.data.createCard("proj", { title, status: "ready" })).id;

  it("blocks with a question: the first line is the attention, the whole is logged", async () => {
    const id = await made("Pick a database");
    expect((await tool("block", { board: "proj", id, question: "Postgres or SQLite?" })).text).toContain("held by nobody");
    await json("claim_card", { board: "proj", id });
    expect((await tool("block", { board: "proj", id, question: "  \n " })).text).toBe("say what you need");
    const out = await json("block", { board: "proj", id, question: "Postgres or SQLite?\nPostgres for the replicas, SQLite for one box." });
    expect(out).toMatchObject({ agent_state: "blocked", attention: "Postgres or SQLite?", status: "doing" });
    expect(n.data.card("proj", id).log.at(-1)!.note).toBe("blocked: Postgres or SQLite?\nPostgres for the replicas, SQLite for one box.");
    // An attention over 200 characters is cut with an ellipsis.
    const long = await json("block", { board: "proj", id, question: "x".repeat(300) });
    expect(long.attention).toHaveLength(200);
    expect(long.attention.endsWith("…")).toBe(true);
  });

  it("asks the user to act, stopping or not as wait says", async () => {
    const id = await made("Log in to the registry");
    await json("claim_card", { board: "proj", id });
    const go = await json("request_user_action", { board: "proj", id, message: "Approve the deploy key.", wait: false });
    expect(go).toMatchObject({ agent_state: "working", attention: "Approve the deploy key." });
    expect(n.data.card("proj", id).log.at(-1)!.note).toBe("needs you: Approve the deploy key.");
    const stop = await json("request_user_action", { board: "proj", id, message: "Log in to the registry." });
    expect(stop.agent_state).toBe("blocked");
    expect(n.data.card("proj", id).log.at(-1)!.note).toBe("blocked: Log in to the registry.");
  });

  it("releases a card back to ready, unassigned, and only its holder may", async () => {
    const id = await made("Put off");
    expect((await tool("release_card", { board: "proj", id, note: "later" })).error).toBe(true);
    await json("claim_card", { board: "proj", id });
    await json("block", { board: "proj", id, question: "Now?" });
    const out = await json("release_card", { board: "proj", id, note: "The user said tomorrow." });
    expect(out).toMatchObject({ status: "ready", agent: "", agent_state: "", attention: "" });
    expect(n.data.card("proj", id).log.at(-1)!.note).toBe("released: The user said tomorrow.");
    // Gone back, another can claim it.
    await n.data.updateCard("proj", id, { agent: "someone", agent_state: "working", status: "doing" });
    expect((await tool("release_card", { board: "proj", id, note: "mine now" })).text).toContain("held by someone, not assistant");
  });

  it("submits for review with the summary and how it was verified, and the PR's number", async () => {
    const id = await made("Fix the merge");
    expect((await tool("submit_for_review", { board: "proj", id, summary: "x", verification: "y" })).error).toBe(true);
    await json("claim_card", { board: "proj", id });
    await json("block", { board: "proj", id, question: "Squash?" });
    const out = await json("submit_for_review", { board: "proj", id, summary: "Merged per field.", verification: "The fuzz test.", pr: "12" });
    expect(out).toMatchObject({ status: "review", agent_state: "needs-review", attention: "", agent: "assistant" });
    const card = n.data.card("proj", id);
    expect(card.extra.pr).toBe(12);
    expect(card.log.at(-1)!.note).toBe("Merged per field.\nVerified: The fuzz test.");
    // Without a PR, extra is left as it was.
    const other = await made("No PR");
    await json("claim_card", { board: "proj", id: other });
    await json("submit_for_review", { board: "proj", id: other, summary: "s", verification: "v" });
    expect(n.data.card("proj", other).extra).not.toHaveProperty("pr");
  });

  it("replaces a card's description, keeping its log", async () => {
    const id = await made("Describe me");
    await json("log", { board: "proj", id, note: "first" });
    await json("write_description", { board: "proj", id, description: "  ## Why\nBecause.\n\n" });
    const read = await json("read_card", { board: "proj", id });
    expect(read.description).toBe("## Why\nBecause.");
    expect(read.log).toContain("first");
    // Writing the same again changes nothing and logs nothing.
    const before = n.data.card("proj", id);
    await json("write_description", { board: "proj", id, description: "## Why\nBecause." });
    expect(n.data.card("proj", id).version).toBe(before.version);
  });

  it("refuses a card the budget guard holds, but lets its agent read, ask and let it go", async () => {
    const id = await made("Expensive");
    await json("claim_card", { board: "proj", id });
    await n.data.updateCard("proj", id, { extra: { budget_hold: "$20 of $20 spent" } });
    for (const [name, args] of [
      ["log", { note: "more" }],
      ["write_description", { description: "x" }],
      ["submit_for_review", { summary: "s", verification: "v" }],
      ["update_card", { title: "y" }],
    ] as const) {
      const r = await tool(name, { board: "proj", id, ...args });
      expect(r).toEqual({ error: true, text: `budget reached on ${id}: $20 of $20 spent. Stop working on it and wait; the user has been told and will answer on the card.` });
    }
    expect((await json("read_card", { board: "proj", id })).budget_hold).toBe("$20 of $20 spent");
    expect((await json("block", { board: "proj", id, question: "Raise the budget?" })).agent_state).toBe("blocked");
    await json("request_user_action", { board: "proj", id, message: "Raise it.", wait: false });
    expect((await json("release_card", { board: "proj", id, note: "out of budget" })).status).toBe("ready");
    // Nor does next_card hand it out.
    await n.data.updateCard("proj", id, { status: "ready" });
    for (const c of n.data.cards("proj")) if (c.id !== id && c.status === "ready") await n.data.updateCard("proj", c.id, { status: "backlog" });
    expect((await tool("next_card", { board: "proj" })).text).toBe("null");
  });

  it("holds a card's own agent to its card", async () => {
    const mine = await made("Mine");
    const theirs = await made("Theirs");
    const { token: bound } = n.oauth.mintBound({ scope: "card", board: "proj", card: mine, agent: "fleet" });
    await n.data.updateCard("proj", mine, { agent: "fleet", agent_state: "working", status: "doing" });
    expect((await tool("block", { id: theirs, question: "?" }, bound)).text).toBe(`this session works on ${mine}; it can read other cards but not change them`);
    expect(JSON.parse((await tool("block", { id: mine, question: "Which?" }, bound)).text).agent_state).toBe("blocked");
  });
});

describe("notes and brains, read over the node's MCP", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => void (n = await setup()));
  afterAll(() => n.stop());
  const tool = async (name: string, args: Record<string, unknown>, as: string) => toolText(await n.call("/mcp", rpc("tools/call", { name, arguments: args }, as)));

  it("reads a note by its id, refuses one that isn't an id, and hides the brain's goals from the user's clients", async () => {
    const as = n.oauth.mint("claude.ai", 1, "assistant");
    await n.data.putNote("assistant", "deploys", { kind: "project", title: "Deploys", body: "Caddy in front." });
    await n.data.putNote("assistant", "goal-ship", { kind: "goal", title: "Ship", body: "By Friday." });
    expect((await tool("note_read", { id: "Deploys" }, as)).text).toContain("lowercase letters");
    const read = await tool("note_read", { id: "deploys" }, as);
    expect(read.error).toBe(false);
    expect(JSON.parse(read.text)).toMatchObject({ id: "deploys", kind: "project", title: "Deploys", body: "Caddy in front." });
    expect(await tool("note_read", { id: "nothing-here" }, as)).toEqual({ error: true, text: "no note nothing-here" });
    expect(await tool("note_read", { id: "goal-ship" }, as)).toEqual({ error: true, text: "no note goal-ship" });
    // The brain's own agent sees its goals.
    const brain = n.oauth.mint("pepper", 1, "assistant", "assistant");
    expect(JSON.parse((await tool("note_read", { id: "goal-ship" }, brain)).text).body).toBe("By Friday.");
  });

  it("lists the brains and reads one with its memory's counts", async () => {
    const as = n.oauth.mint("claude.ai", 1, "assistant");
    await n.data.remember("assistant", "assistant", "One thing.");
    await n.data.remember("assistant", "assistant", "Another.");
    const list = JSON.parse((await tool("brain_list", {}, as)).text) as { name: string; default: boolean }[];
    expect(list.map((b) => [b.name, b.default])).toEqual([["assistant", true]]);
    const read = JSON.parse((await tool("brain_read", { name: "assistant" }, as)).text);
    expect(read.name).toBe("assistant");
    expect(read.memory).toEqual({ notes: n.data.notes("assistant").length, entries: 2 });
    expect(await tool("brain_read", { name: "constructor" }, as)).toEqual({ error: true, text: "no brain constructor; brain_list lists them" });
  });
});
