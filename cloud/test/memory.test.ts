import { reset, runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { google, login, ownerToken, worker } from "./login";

const USER = "sub-me@example.com";
const env = bindings as unknown as Env;

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
  return body.result.isError ? { error: text } : text.startsWith("#") ? text : JSON.parse(text);
}

const pepperToken = async () => (await (await call(owner, "POST", "/api/tokens/pepper", {})).json<any>()).token as string;

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

describe("Pepper's brain", () => {
  it("starts with the notes the user's object had", async () => {
    await runInDurableObject(env.USER.get(env.USER.idFromName(USER)), (_o, state) => {
      state.storage.sql.exec(
        "INSERT INTO notes (id, kind, title, body, created, updated) VALUES ('old-friend', 'person', 'Sam', 'Met at the climbing gym', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
      );
    });
    expect((await tool(assistant, "note_read", { id: "old-friend" })).body).toBe("Met at the climbing gym");
    expect((await (await call(owner, "GET", "/api/notes/old-friend")).json<any>()).title).toBe("Sam");
  });

  it("refuses a write over a version someone else changed", async () => {
    const first = await tool(assistant, "note_write", { id: "plan", kind: "project", title: "Plan", body: "one" });
    expect(first.version).toBe(1);
    expect((await tool(assistant, "note_write", { id: "plan", kind: "project", title: "Plan", body: "two", version: 1 })).version).toBe(2);
    expect((await tool(assistant, "note_write", { id: "plan", kind: "project", title: "Plan", body: "three", version: 1 })).error).toMatch(/version 2, not 1/);
    expect((await tool(assistant, "note_write", { id: "fresh", kind: "project", title: "Fresh", body: "x", version: 0 })).version).toBe(1);
    const stale = await call(owner, "PUT", "/api/notes/plan", { kind: "project", title: "Plan", body: "four", version: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json<any>()).note.body).toBe("two");
  });
});

describe("the log and recall", () => {
  it("remembers a line on today, and recalls it with the notes", async () => {
    await tool(assistant, "note_write", { id: "climbing", kind: "project", title: "Climbing", body: "Bouldering twice a week at the gym." });
    const e = await tool(assistant, "memory_remember", { text: "Sent the climbing gym the waiver." });
    expect(e.who).toBe("assistant");
    const hits = await tool(assistant, "memory_recall", { query: "climbing waiver" });
    expect(hits.map((h: any) => h.type).sort()).toEqual(["entry", "note"]);
    expect((await tool(assistant, "memory_grep", { text: "WAIVER" }))[0].line).toBe("Sent the climbing gym the waiver.");
  });

  it("starts a session with the soul, the log and what was learned", async () => {
    await call(owner, "PUT", "/api/notes/soul", { kind: "memory", title: "Soul", body: "Be kind and brief." });
    await tool(assistant, "note_write", { id: "learned", kind: "memory", title: "Learned", body: "Matt plans on Sundays." });
    await tool(assistant, "memory_remember", { text: "Booked the dentist for Friday." });
    const pepper = await pepperToken();
    const res = await call(pepper, "GET", "/memory/context");
    expect(res.headers.get("Content-Type")).toMatch(/markdown/);
    const text = await res.text();
    expect(text).toMatch(/^# Memory: pepper/);
    expect(text.indexOf("Be kind and brief.")).toBeLessThan(text.indexOf("Booked the dentist"));
    expect(text.indexOf("Booked the dentist")).toBeLessThan(text.indexOf("Matt plans on Sundays."));
    expect((await tool(assistant, "memory_context", { budget: 1000 })).length).toBeLessThanOrEqual(1100);
  });

  it("puts the goals in the context of those who may see them, after the long-term memory", async () => {
    await call(owner, "PUT", "/api/notes/memory", { kind: "memory", title: "MEMORY.md", body: "Curated: Matt ships on Fridays." });
    await call(owner, "PUT", "/api/notes/goal-run", { kind: "goal", title: "Run", body: "A marathon in spring." });
    await tool(assistant, "memory_remember", { text: "Ran 5k today." });
    const pepper = await (await call(await pepperToken(), "GET", "/memory/context")).text();
    expect(pepper.indexOf("Curated")).toBeLessThan(pepper.indexOf("A marathon"));
    expect(pepper.indexOf("A marathon")).toBeLessThan(pepper.indexOf("Ran 5k"));
    expect(await tool(assistant, "memory_context", {})).not.toMatch(/marathon/);
  });

  it("keeps the goals out of everything but Pepper's", async () => {
    await call(owner, "PUT", "/api/notes/goals", { kind: "goal", title: "Goals", body: "Run a marathon in spring." });
    await call(owner, "PUT", "/api/notes/learned", { kind: "memory", title: "Learned", body: "Marathon training starts in January." });
    expect((await tool(assistant, "memory_recall", { query: "marathon" })).map((h: any) => h.id)).toEqual(["learned"]);
    expect((await tool(assistant, "memory_grep", { text: "marathon" })).map((g: any) => g.where)).toEqual(["learned:1"]);
    const pepper = await pepperToken();
    expect((await tool(pepper, "memory_recall", { query: "marathon" })).map((h: any) => h.id).sort()).toEqual(["goals", "learned"]);
  });
});

describe("episodes", () => {
  it("are kept once, whole, and listed until consolidated", async () => {
    const pepper = await pepperToken();
    const transcript = '{"type":"user","message":"hi"}\n'.repeat(70_000);
    const sent = await call(pepper, "POST", "/memory/episodes", { session: "s1", trigger: "end", transcript });
    expect(sent.status).toBe(201);
    const { id } = await sent.json<any>();
    expect((await call(pepper, "POST", "/memory/episodes", { session: "s1", trigger: "end", transcript })).status).toBe(200);
    const pending = await (await call(pepper, "GET", "/memory/episodes?pending=1")).json<any[]>();
    expect(pending.map((e) => [e.id, e.agent, e.bytes])).toEqual([[id, "pepper", transcript.length]]);
    expect((await (await call(pepper, "GET", `/memory/episodes/${id}`)).json<any>()).transcript).toBe(transcript);
  });

  it("of a session resumed again replace the last, not pile up", async () => {
    const pepper = await pepperToken();
    await call(pepper, "POST", "/memory/episodes", { session: "phone", transcript: "turn 1\n" });
    await call(pepper, "POST", "/memory/episodes", { session: "phone", transcript: "turn 1\nturn 2\n" });
    await call(pepper, "POST", "/memory/episodes", { session: "other", transcript: "x\n" });
    const all = await (await call(pepper, "GET", "/memory/episodes")).json<any[]>();
    expect(all.map((e) => [e.session, e.bytes]).sort()).toEqual([["other", 2], ["phone", 14]]);
  });

  it("need a session and a transcript", async () => {
    const pepper = await pepperToken();
    expect((await call(pepper, "POST", "/memory/episodes", { transcript: "x" })).status).toBe(400);
    expect((await call(pepper, "POST", "/memory/episodes", { session: "s" })).status).toBe(400);
  });

  it("aren't a card token's to send", async () => {
    await call(owner, "PUT", "/api/boards/b", { name: "B" });
    await call(owner, "POST", "/api/boards/b/cards", { title: "T" });
    const { token } = await (await call(owner, "POST", "/api/tokens", { board: "b", card: "TASK-1", agent: "a" })).json<any>();
    expect((await call(token, "GET", "/memory/context")).status).toBe(403);
  });
});

describe("brains", () => {
  const brainToken = async (brain: string) => call(owner, "POST", "/api/tokens/brain", { brain });

  it("each have their own memory, and their goals are their own agents'", async () => {
    const work = (await (await brainToken("work")).json<any>()).token as string;
    await call(owner, "PUT", "/api/notes/goals?brain=work", { kind: "goal", title: "Ship", body: "Launch the lending portal." });
    await call(owner, "PUT", "/api/notes/stack?brain=work", { kind: "reference", title: "Stack", body: "SST on AWS." });
    await call(owner, "PUT", "/api/notes/goal-fitness", { kind: "goal", title: "Fitness", body: "Three sessions a week." });
    expect((await tool(work, "note_read", { id: "goals" })).body).toBe("Launch the lending portal.");
    expect((await tool(work, "note_read", { id: "goal-fitness" })).error).toMatch(/no note/);
    expect((await tool(assistant, "note_read", { id: "stack" })).error).toMatch(/no note/);
    expect((await tool(assistant, "note_read", { id: "goal-fitness" })).error).toMatch(/no note/);
    const pepper = await pepperToken();
    expect((await tool(pepper, "note_read", { id: "goal-fitness" })).body).toBe("Three sessions a week.");
    expect(await (await call(work, "GET", "/memory/context")).text()).toMatch(/^# Memory: work/);
  });

  it("are named, and Pepper's token is Pepper's own", async () => {
    expect((await brainToken("pepper")).status).toBe(400);
    expect((await brainToken("nobody")).status).toBe(400);
    expect((await call(owner, "GET", "/api/notes?brain=nobody")).status).toBe(400);
  });
});

describe("a sync", () => {
  it("adds each entry once, on its own day", async () => {
    const entries = [
      { day: "2026-10-26", at: "2026-10-26T17:00:00Z", who: "brain-vm", text: "Shipped PR 191.", key: "a" },
      { day: "2026-10-26", at: "2026-10-26T18:00:00Z", who: "brain-vm", text: "Asked about aws logs.", key: "b" },
    ];
    expect((await (await call(owner, "POST", "/api/memory/entries?brain=work", { entries })).json<any>()).added).toBe(2);
    expect((await (await call(owner, "POST", "/api/memory/entries?brain=work", { entries })).json<any>()).added).toBe(0);
    const work = (await (await call(owner, "POST", "/api/tokens/brain", { brain: "work" })).json<any>()).token as string;
    expect((await tool(work, "memory_recall", { query: "PR 191" }))[0].day).toBe("2026-10-26");
    expect((await call(owner, "POST", "/api/memory/entries?brain=work", { entries: [{ day: "26 Oct", at: "x", text: "y", key: "c" }] })).status).toBe(400);
  });

  it("of an unchanged note leaves it be, and keeps where it came from", async () => {
    const put = (body: object) => call(owner, "PUT", "/api/notes/decisions-x?brain=work", { kind: "decision", title: "X", body: "Because.", ...body });
    expect((await (await put({ path: "Decisions/x.md" })).json<any>()).version).toBe(1);
    expect((await (await put({ path: "Decisions/x.md" })).json<any>()).version).toBe(1);
    const changed = await (await put({ body: "Because, still." })).json<any>();
    expect([changed.version, changed.path]).toEqual([2, "Decisions/x.md"]);
    expect((await put({ path: "../etc/passwd" })).status).toBe(400);
  });
});

describe("dates", () => {
  it("are worked out for the log and for recall", async () => {
    await call(owner, "POST", "/api/memory/entries", {
      entries: [
        { day: "2026-10-20", at: "2026-10-20T17:00:00Z", who: "pepper", text: "Long run, 12k.", key: "r" },
        { day: "2026-10-21", at: "2026-10-21T17:00:00Z", who: "pepper", text: "Rest day.", key: "s" },
      ],
    });
    const log = await tool(assistant, "memory_log", { from: "2026-10-20", to: "2026-10-21" });
    expect(log.entries.map((e: any) => e.text)).toEqual(["Long run, 12k.", "Rest day."]);
    expect((await tool(assistant, "memory_log", { when: "sometime" })).error).toMatch(/can't tell/);
    // Nothing on 20 Oct says "happened"; the date finds it.
    const hits = await tool(assistant, "memory_recall", { query: "what happened on 2026-10-20" });
    expect(hits.map((h: any) => h.snippet)).toContain("Long run, 12k.");
  });
});
