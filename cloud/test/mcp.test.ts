import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken, worker } from "./login";

const BOARD = "home-matthew-agent-ide";
let owner: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  owner = await ownerToken();
  await call(owner, "PUT", `/api/boards/${BOARD}`, { name: "agent-ide" });
  await call(owner, "POST", `/api/boards/${BOARD}/cards`, { title: "Mine", status: "ready" });
  await call(owner, "POST", `/api/boards/${BOARD}/cards`, { title: "Someone else's", status: "ready" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function cardToken(card = "TASK-1", agent = "claude") {
  const res = await call(owner, "POST", "/api/tokens", { board: BOARD, card, agent });
  expect(res.status).toBe(201);
  return (await res.json<{ token: string }>()).token;
}

let rpcId = 0;
async function rpc(token: string, method: string, params?: unknown) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method, params });
  return { status: res.status, body: res.status === 200 ? await res.json<any>() : await res.text() };
}

// A tool's answer: parsed, or the error text with error set.
async function tool(token: string, name: string, args: object = {}) {
  const { body } = await rpc(token, "tools/call", { name, arguments: args });
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : JSON.parse(text);
}

const card = async (id: string) => (await call(owner, "GET", `/api/boards/${BOARD}/cards/${id}`)).json<any>();

describe("card tokens", () => {
  it("are made by the owner, for a card that exists", async () => {
    expect((await cardToken()).startsWith("cbc_")).toBe(true);
    expect((await call(owner, "POST", "/api/tokens", { board: BOARD, card: "TASK-9", agent: "claude" })).status).toBe(404);
    expect((await call(owner, "POST", "/api/tokens", { board: BOARD, card: "TASK-1" })).status).toBe(400);
  });

  it("reach the MCP server and nothing else", async () => {
    const token = await cardToken();
    expect((await rpc(token, "ping")).status).toBe(200);
    expect((await call(token, "GET", "/api/boards")).status).toBe(403);
    expect((await call(token, "POST", "/api/tokens", { board: BOARD, card: "TASK-2", agent: "x" })).status).toBe(403);
  });

  it("stop working when revoked, and a made-up one never works", async () => {
    const token = await cardToken();
    expect((await call(owner, "POST", "/api/tokens/revoke", { token })).status).toBe(204);
    expect((await rpc(token, "ping")).status).toBe(401);
    expect((await rpc("cbc_madeup", "ping")).status).toBe(401);
  });
});

describe("the protocol", () => {
  it("initializes with instructions naming the agent", async () => {
    const { body } = await rpc(await cardToken("TASK-1", "claude-7"), "initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.instructions).toContain('You are "claude-7"');
  });

  it("accepts notifications with 202, refuses GET, and answers batches", async () => {
    const token = await cardToken();
    const note = await call(token, "POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect((await call(token, "GET", "/mcp")).status).toBe(405);
    const batch = await call(token, "POST", "/mcp", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "nope" },
    ]);
    const answers = await batch.json<any[]>();
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect(answers[1].error.code).toBe(-32601);
  });
});

describe("a card agent", () => {
  it("sees the board's tools without a board argument", async () => {
    const { body } = await rpc(await cardToken(), "tools/list");
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("claim_card");
    expect(names).not.toContain("list_boards");
    const claim = body.result.tools.find((t: any) => t.name === "claim_card");
    expect(claim.inputSchema.required).toEqual(["id"]);
  });

  it("works its own card start to finish", async () => {
    const token = await cardToken();
    const claimed = await tool(token, "claim_card", { id: "task-1" });
    expect(claimed).toMatchObject({ id: "TASK-1", status: "doing", agent: "claude", agent_state: "working" });
    await tool(token, "log", { id: "TASK-1", note: "halfway" });
    await tool(token, "write_description", { id: "TASK-1", description: "what it is" });
    const done = await tool(token, "submit_for_review", { id: "TASK-1", summary: "did it", verification: "tests" });
    expect(done).toMatchObject({ status: "review", agent_state: "needs-review" });
    const c = await card("TASK-1");
    expect(c.description).toBe("what it is");
    expect(c.log.map((e: any) => [e.who, e.note])).toEqual([
      ["claude", "claimed"],
      ["claude", "halfway"],
      ["claude", "did it\nVerified: tests"],
    ]);
  });

  it("reads other cards but can't change them", async () => {
    const token = await cardToken();
    expect((await tool(token, "read_card", { id: "TASK-2" })).title).toBe("Someone else's");
    for (const [name, args] of [
      ["claim_card", { id: "TASK-2" }],
      ["log", { id: "TASK-2", note: "x" }],
      ["update_card", { id: "TASK-2", status: "done" }],
    ] as const) {
      expect((await tool(token, name, args)).error).toMatch(/works on TASK-1/);
    }
    expect((await card("TASK-2")).version).toBe(1);
  });

  it("is only handed its own card by next_card", async () => {
    const token = await cardToken("TASK-1");
    expect((await tool(token, "next_card")).id).toBe("TASK-1");
    expect(await tool(token, "next_card")).toBeNull();
  });

  it("makes follow-ups of its own card, linked both ways", async () => {
    const token = await cardToken();
    const made = await tool(token, "create_card", { title: "Follow-up\nwork", parent: "TASK-1", labels: ["x"] });
    expect(made).toMatchObject({ id: "TASK-3", title: "Follow-up work", status: "backlog", labels: ["x"] });
    expect((await card("TASK-1")).log.at(-1).note).toBe("follow-up: TASK-3");
    expect((await card("TASK-3")).log.at(-1).note).toBe("created from TASK-1");
    expect((await tool(token, "create_card", { title: "x", parent: "TASK-2" })).error).toMatch(/own card/);
  });

  it("asks the user, raising attention", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    const blocked = await tool(token, "block", { id: "TASK-1", question: "Which API?\nA or B" });
    expect(blocked).toMatchObject({ agent_state: "blocked", attention: "Which API?" });
  });

  it("keeps to the rules mcp/board.ts had", async () => {
    const token = await cardToken();
    expect((await tool(token, "submit_for_review", { id: "TASK-1", summary: "s", verification: "v" })).error).toMatch(/claim it first/);
    expect((await tool(token, "update_card", { id: "TASK-1", status: "later" })).error).toMatch(/status must be/);
    await call(owner, "PATCH", `/api/boards/${BOARD}/cards/TASK-1`, { version: 1, dependencies: ["TASK-2"] });
    expect((await tool(token, "claim_card", { id: "TASK-1" })).error).toMatch(/waits on TASK-2/);
    expect((await tool(token, "claim_card", { id: "TASK-1", force: true })).status).toBe("doing");
  });

  it("is stopped by a budget hold, except to read, ask or let go", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    const c = await card("TASK-1");
    await call(owner, "PATCH", `/api/boards/${BOARD}/cards/TASK-1`, { version: c.version, extra: { budget_hold: "$5 spent" } });
    expect((await tool(token, "log", { id: "TASK-1", note: "x" })).error).toMatch(/budget reached on TASK-1: \$5 spent/);
    expect((await tool(token, "read_card", { id: "TASK-1" })).budget_hold).toBe("$5 spent");
    expect((await tool(token, "block", { id: "TASK-1", question: "more budget?" })).agent_state).toBe("blocked");
  });
});

describe("an OAuth client", () => {
  it("lists boards and names one on every call", async () => {
    const { body } = await rpc(owner, "tools/list");
    const tools = body.result.tools;
    expect(tools[0].name).toBe("list_boards");
    expect(tools.find((t: any) => t.name === "read_card").inputSchema.required).toEqual(["board", "id"]);
    expect(await tool(owner, "list_boards")).toEqual([{ key: BOARD, name: "agent-ide", root: null }]);
    expect((await tool(owner, "read_card", { board: BOARD, id: "TASK-2" })).title).toBe("Someone else's");
    expect((await tool(owner, "read_card", { id: "TASK-2" })).error).toMatch(/which board/);
    expect((await tool(owner, "read_card", { board: "nope", id: "TASK-2" })).error).toMatch(/no such board/);
  });
});
