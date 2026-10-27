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
