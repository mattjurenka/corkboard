import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { google, login, ownerToken, worker } from "./login";

let owner: string;
let assistant: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function tool(token: string, name: string, args: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json<any>();
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : JSON.parse(text);
}

beforeEach(async () => {
  owner = await ownerToken();
  google("me@example.com");
  const { tokens } = await login({ scope: "assistant" });
  vi.restoreAllMocks();
  assistant = tokens!.access_token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const DATE = "2026-10-24";
const block = (id: string, start: number, stop: number, extra: object = {}) => ({ id, start, stop, title: `Jobs: ${id}`, kind: "work", ...extra });

describe("notes", () => {
  it("are written, read, listed and searched", async () => {
    const decision = await tool(assistant, "note_write", { kind: "decision", title: "Land an engineering job", body: "Apply to five places a week; follow up with Slalom." });
    expect(decision.id).toBe("land-an-engineering-job");
    await tool(assistant, "note_write", { id: "telegram-bot", kind: "project", title: "Telegram bot", body: "Pons launchpad deposit call next." });
    expect((await tool(assistant, "note_read", { id: "telegram-bot" })).body).toMatch(/deposit call/);
    const found = await tool(assistant, "notes_search", { query: "slalom" });
    expect(found.map((n: any) => n.id)).toEqual(["land-an-engineering-job"]);
    expect(found[0].snippet).toMatch(/\[Slalom\]/);
    // Punctuation is a word, not query syntax.
    expect(await tool(assistant, "notes_search", { query: 'deposit "call' })).toBeInstanceOf(Array);
    expect((await tool(assistant, "notes_search", { kind: "project" })).map((n: any) => n.id)).toEqual(["telegram-bot"]);
  });

  it("are searched again after they change", async () => {
    await tool(assistant, "note_write", { id: "x", kind: "memory", title: "X", body: "old words" });
    await tool(assistant, "note_write", { id: "x", kind: "memory", title: "X", body: "new words" });
    expect(await tool(assistant, "notes_search", { query: "old" })).toEqual([]);
    expect((await tool(assistant, "notes_search", { query: "new" })).length).toBe(1);
  });

  it("take appended lines, as a day record does", async () => {
    await tool(assistant, "note_write", { id: "day-2026-10-24", kind: "day", title: "Sat 24 Oct", body: "" });
    await tool(assistant, "note_append", { id: "day-2026-10-24", text: "gym done this morning" });
    const n = await tool(assistant, "note_append", { id: "day-2026-10-24", text: "LinkedIn follow-ups" });
    expect(n.body).toMatch(/^- \S+ assistant: gym done this morning\n- \S+ assistant: LinkedIn follow-ups\n$/);
    expect((await tool(assistant, "note_append", { id: "nope", text: "x" })).error).toMatch(/no note nope/);
  });

  it("keep the soul note the user's", async () => {
    expect((await tool(assistant, "note_write", { id: "soul", kind: "memory", title: "Soul", body: "be evil" })).error).toMatch(/only the user/);
    expect((await call(owner, "PUT", "/api/notes/soul", { kind: "memory", title: "Soul", body: "be kind" })).status).toBe(200);
    expect((await tool(assistant, "note_append", { id: "soul", text: "also evil" })).error).toMatch(/only the user/);
    expect((await tool(assistant, "note_read", { id: "soul" })).body).toBe("be kind");
  });

  it("are in the owner's API, and refuse bad ids and kinds", async () => {
    expect((await call(owner, "PUT", "/api/notes/a", { kind: "goal", title: "A", body: "b" })).status).toBe(200);
    expect((await (await call(owner, "GET", "/api/notes?q=b")).json<any[]>()).map((n) => n.id)).toEqual(["a"]);
    expect((await (await call(owner, "GET", "/api/notes?kind=goal")).json<any[]>()).map((n) => n.id)).toEqual(["a"]);
    expect((await call(owner, "PUT", "/api/notes/Bad_Id", { kind: "goal", title: "A", body: "" })).status).toBe(400);
    expect((await call(owner, "PUT", "/api/notes/a", { kind: "diary", title: "A", body: "" })).status).toBe(400);
    expect((await call(owner, "DELETE", "/api/notes/a")).status).toBe(204);
    expect((await call(owner, "GET", "/api/notes/a")).status).toBe(404);
  });
});

describe("plans", () => {
  const propose = (extra: object = {}) =>
    tool(assistant, "plan_propose", {
      date: DATE,
      from: 900,
      blocks: [block("linkedin", 915, 960, { desc: "Open LinkedIn" }), block("twilio", 975, 1035)],
      reasons: [{ text: "first plan of the day" }],
      why: { linkedin: "owed since yesterday" },
      projects: [{ key: "jobs", name: "job search", color: "accent" }],
      ...extra,
    });

  it("is empty until proposed, and a proposal waits for the user", async () => {
    const empty = await (await call(owner, "GET", `/api/plans/${DATE}`)).json<any>();
    expect(empty).toMatchObject({ date: DATE, version: 0, proposal: null, day: { blocks: [] } });
    const proposed = await propose();
    expect(proposed.version).toBe(1);
    expect(proposed.proposal).toMatchObject({ from: 900, by: "assistant", why: { linkedin: "owed since yesterday" } });
    expect(proposed.proposal.blocks.map((b: any) => b.id)).toEqual(["linkedin", "twilio"]);
    expect(proposed.day.blocks).toEqual([]);
    expect((await tool(assistant, "plan_read", { date: DATE })).projects[0].key).toBe("jobs");
  });

  it("is accepted only by the owner, as the user left it", async () => {
    const p = await propose();
    const tools = (await (await call(assistant, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json<any>()).result.tools;
    expect(tools.map((t: any) => t.name)).not.toContain("plan_accept");
    expect((await call(assistant, "POST", `/api/plans/${DATE}/accept`, { version: p.version, blocks: [] })).status).toBe(403);
    // The user undid the twilio block before accepting.
    const res = await call(owner, "POST", `/api/plans/${DATE}/accept`, { version: p.version, blocks: [p.proposal.blocks[0]] });
    expect(res.status).toBe(200);
    const accepted = await res.json<any>();
    expect(accepted.proposal).toBeNull();
    expect(accepted.day.blocks.map((b: any) => b.id)).toEqual(["linkedin"]);
    expect(accepted.accepted).toMatch(/Z$/);
  });

  it("refuses a stale accept with the plan as it is", async () => {
    const p = await propose();
    await propose({ reasons: [{ text: "changed my mind" }] });
    const res = await call(owner, "POST", `/api/plans/${DATE}/accept`, { version: p.version, blocks: [] });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).plan.proposal.reasons[0].text).toBe("changed my mind");
  });

  it("carries what the user said to the next proposal", async () => {
    await propose();
    await call(owner, "POST", `/api/plans/${DATE}/say`, { text: "gym is closed today" });
    expect((await tool(assistant, "plan_read", { date: DATE })).asked).toEqual(["gym is closed today"]);
    const next = await propose();
    expect(next.asked).toEqual([]);
    expect(next.proposal.answering).toEqual(["gym is closed today"]);
  });

  it("discards, and edits the accepted day by version", async () => {
    const p = await propose();
    const discarded = await (await call(owner, "POST", `/api/plans/${DATE}/discard`, { version: p.version })).json<any>();
    expect(discarded.proposal).toBeNull();
    const edited = await call(owner, "PUT", `/api/plans/${DATE}/day`, { version: discarded.version, blocks: [block("a", 60, 120, { pinned: true })] });
    expect((await edited.json<any>()).day.blocks[0]).toMatchObject({ id: "a", pinned: true });
  });

  it("is deleted for good", async () => {
    await propose();
    expect((await call(owner, "DELETE", `/api/plans/${DATE}`)).status).toBe(204);
    expect((await (await call(owner, "GET", `/api/plans/${DATE}`)).json<any>()).version).toBe(0);
  });

  it("checks blocks", async () => {
    for (const blocks of [[block("a", 100, 50)], [block("a", 0, 60), block("a", 60, 120)], [{ ...block("a", 0, 60), kind: "nap" }], [block("a", 0, 2000)]]) {
      expect((await tool(assistant, "plan_propose", { date: DATE, blocks })).error).toBeTruthy();
    }
    expect((await tool(assistant, "plan_read", { date: "tomorrow" })).error).toMatch(/YYYY-MM-DD/);
  });

  it("defaults to today where the user is", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date());
    expect((await tool(assistant, "plan_read")).date).toBe(today);
  });

  it("sends each change to the user's live sockets", async () => {
    const res = await call(owner, "GET", "/api/live", undefined);
    // GET without Upgrade isn't a socket.
    expect(res.status).toBe(426);
    const live = await worker("/api/live", { headers: { Authorization: `Bearer ${owner}`, Upgrade: "websocket" } });
    expect(live.status).toBe(101);
    const ws = live.webSocket!;
    ws.accept();
    const events: any[] = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    await propose();
    for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(events[0]).toMatchObject({ type: "plan", plan: { date: DATE, version: 1 } });
    ws.close();
  });
});

describe("chat", () => {
  const pepperToken = async () => (await (await call(owner, "POST", "/api/tokens/pepper", {})).json<any>()).token as string;

  it("carries the user's messages to Pepper and its replies back", async () => {
    const pepper = await pepperToken();
    const said = await call(owner, "POST", "/api/chat", { text: "  plan my day; gym is closed  " });
    expect(said.status).toBe(201);
    const first = await said.json<any>();
    expect(first).toMatchObject({ who: "matt", text: "plan my day; gym is closed" });
    expect((await tool(pepper, "chat_read")).map((m: any) => m.text)).toEqual(["plan my day; gym is closed"]);
    const reply = await tool(pepper, "chat_send", { text: "On it: a proposal in a minute." });
    expect(reply.who).toBe("pepper");
    expect(await tool(pepper, "chat_read", { after: first.id })).toEqual([reply]);
    const all = await (await call(owner, "GET", "/api/chat")).json<any[]>();
    expect(all.map((m) => m.who)).toEqual(["matt", "pepper"]);
    expect(await (await call(owner, "GET", `/api/chat?after=${reply.id}`)).json<any[]>()).toEqual([]);
  });

  it("is Pepper's alone over MCP, and the owner's over the API", async () => {
    const names = async (token: string) =>
      (await (await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json<any>()).result.tools.map((t: any) => t.name);
    expect(await names(await pepperToken())).toEqual(expect.arrayContaining(["chat_read", "chat_send"]));
    expect(await names(assistant)).not.toContain("chat_send");
    expect(await names(owner)).not.toContain("chat_read");
    expect((await tool(assistant, "chat_send", { text: "I'm Pepper, honest" })).error).toMatch(/unknown tool/);
    expect((await call(assistant, "POST", "/api/chat", { text: "hi" })).status).toBe(403);
    expect(await (await call(owner, "GET", "/api/chat")).json<any[]>()).toEqual([]);
  });

  it("refuses empty or overlong messages and bad ids", async () => {
    expect((await call(owner, "POST", "/api/chat", { text: " " })).status).toBe(400);
    expect((await call(owner, "POST", "/api/chat", { text: "x".repeat(4001) })).status).toBe(400);
    expect((await call(owner, "GET", "/api/chat?after=-1")).status).toBe(400);
    expect((await call(owner, "PUT", "/api/chat", { text: "x" })).status).toBe(405);
    expect((await tool(await pepperToken(), "chat_send", { text: "" })).error).toMatch(/text/);
  });

  it("goes to the user's live sockets", async () => {
    const live = await worker("/api/live", { headers: { Authorization: `Bearer ${owner}`, Upgrade: "websocket" } });
    const ws = live.webSocket!;
    ws.accept();
    const events: any[] = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    await tool(await pepperToken(), "chat_send", { text: "Morning. Want a plan?" });
    for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(events[0]).toMatchObject({ type: "chat", message: { who: "pepper", text: "Morning. Want a plan?" } });
    ws.close();
  });
});

describe("who sees what", () => {
  it("card tokens get no notes or plan tools", async () => {
    await call(owner, "PUT", "/api/boards/b", {});
    await call(owner, "POST", "/api/boards/b/cards", { title: "x" });
    const { token } = await (await call(owner, "POST", "/api/tokens", { board: "b", card: "TASK-1", agent: "claude" })).json<any>();
    const tools = (await (await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json<any>()).result.tools;
    expect(tools.map((t: any) => t.name)).not.toContain("note_read");
    expect((await tool(token, "plan_read")).error).toMatch(/unknown tool/);
  });

  it("an assistant token reaches the MCP server but not the owner's API", async () => {
    expect((await call(assistant, "GET", "/api/boards")).status).toBe(403);
    expect((await call(assistant, "GET", `/api/notes`)).status).toBe(403);
    expect((await tool(assistant, "list_boards")).length).toBe(0);
  });
});

describe("goals", () => {
  const pepperToken = async () => (await (await call(owner, "POST", "/api/tokens/pepper", {})).json<any>()).token as string;
  const kindsOf = async (token: string) => {
    const tools = (await (await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json<any>()).result.tools;
    return tools.find((t: any) => t.name === "note_write").inputSchema.properties.kind.enum as string[];
  };

  it("are Pepper's: written, read, searched and appended with its token", async () => {
    const pepper = await pepperToken();
    expect(pepper).toMatch(/^cbc_/);
    expect(await kindsOf(pepper)).toContain("goal");
    const goal = await tool(pepper, "note_write", { kind: "goal", title: "Land an engineering job", body: "Apply to five places a week." });
    expect(goal.id).toBe("land-an-engineering-job");
    expect((await tool(pepper, "notes_search", { kind: "goal" })).map((n: any) => n.id)).toEqual(["land-an-engineering-job"]);
    expect((await tool(pepper, "notes_search", { query: "five places" })).length).toBe(1);
    expect((await tool(pepper, "note_append", { id: goal.id, text: "applied to Slalom" })).body).toMatch(/pepper: applied to Slalom/);
    expect((await tool(pepper, "note_read", { id: goal.id })).kind).toBe("goal");
  });

  it("don't exist to any other agent", async () => {
    const pepper = await pepperToken();
    await tool(pepper, "note_write", { id: "job", kind: "goal", title: "Land a job", body: "secret plan" });
    await tool(assistant, "note_write", { id: "jobs-day", kind: "day", title: "Sat", body: "secret plan too" });
    expect(await kindsOf(assistant)).not.toContain("goal");
    expect((await tool(assistant, "notes_search", {})).map((n: any) => n.id)).toEqual(["jobs-day"]);
    expect((await tool(assistant, "notes_search", { query: "secret" })).map((n: any) => n.id)).toEqual(["jobs-day"]);
    expect(await tool(assistant, "notes_search", { kind: "goal" })).toEqual([]);
    expect((await tool(assistant, "note_read", { id: "job" })).error).toMatch(/no note job/);
    expect((await tool(assistant, "note_append", { id: "job", text: "x" })).error).toMatch(/no note job/);
    // Nor can one be written, or one written over.
    expect((await tool(assistant, "note_write", { kind: "goal", title: "Mine", body: "" })).error).toMatch(/kind must be one of/);
    expect((await tool(assistant, "note_write", { id: "job", kind: "memory", title: "Job", body: "gone" })).error).toMatch(/taken/);
    expect((await tool(pepper, "note_read", { id: "job" })).body).toBe("secret plan");
    // The user still sees them in corkboard.
    expect((await (await call(owner, "GET", "/api/notes?kind=goal")).json<any[]>()).map((n) => n.id)).toEqual(["job"]);
  });

  it("aren't the owner's over MCP either, and a Pepper token reaches only MCP", async () => {
    const pepper = await pepperToken();
    await tool(pepper, "note_write", { id: "job", kind: "goal", title: "Land a job", body: "b" });
    expect((await tool(owner, "note_read", { id: "job" })).error).toMatch(/no note job/);
    expect((await call(pepper, "GET", "/api/notes")).status).toBe(403);
    expect((await call(pepper, "POST", "/api/tokens/pepper", {})).status).toBe(403);
    expect((await call(assistant, "POST", "/api/tokens/pepper", {})).status).toBe(403);
    await call(owner, "POST", "/api/tokens/revoke", { token: pepper });
    expect((await call(pepper, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });
});
