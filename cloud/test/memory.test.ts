import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { google, login, ownerToken, worker } from "./login";
import { bullets, parseRollup, render } from "../src/consolidate";
import { today } from "../src/plans";

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

const pepperToken = async () => (await (await call(owner, "POST", "/api/brains/pepper/tokens", {})).json<any>()).token as string;

beforeEach(async () => {
  owner = await ownerToken();
  google("me@example.com");
  const { tokens } = await login({ scope: "assistant" });
  vi.restoreAllMocks();
  assistant = tokens!.access_token;
  // Only Pepper is there to begin with.
  expect((await call(owner, "POST", "/api/brains", { name: "work", title: "Stable" })).status).toBe(201);
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
  const brainToken = async (brain: string) => call(owner, "POST", `/api/brains/${brain}/tokens`, {});

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

  it("are named, and Pepper's token is the pepper brain's", async () => {
    expect((await brainToken("pepper")).status).toBe(201);
    expect((await brainToken("nobody")).status).toBe(404);
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
    const work = (await (await call(owner, "POST", "/api/brains/work/tokens", {})).json<any>()).token as string;
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

describe("the brains view", () => {
  it("reads a brain's log by day, its episodes and recall", async () => {
    await call(owner, "POST", "/api/memory/entries?brain=work", {
      entries: [
        { day: "2026-10-26", at: "2026-10-26T17:00:00Z", who: "brain-vm", text: "Shipped PR 191.", key: "a" },
        { day: "2026-10-26", at: "2026-10-26T18:00:00Z", who: "brain-vm", text: "Asked about aws logs.", key: "b" },
        { day: "2026-10-27", at: "2026-10-27T17:00:00Z", who: "brain-vm", text: "Reviewed the lending portal.", key: "c" },
      ],
    });
    const get = async (path: string) => (await call(owner, "GET", path)).json<any>();
    expect(await get("/api/memory/days?brain=work")).toEqual([
      { day: "2026-10-27", entries: 1 },
      { day: "2026-10-26", entries: 2 },
    ]);
    expect((await get("/api/memory/entries?brain=work&day=2026-10-26")).map((e: any) => e.text)).toEqual(["Shipped PR 191.", "Asked about aws logs."]);
    expect((await get("/api/memory/entries?brain=work&from=2026-10-26&to=2026-10-27")).length).toBe(3);
    expect((await call(owner, "GET", "/api/memory/entries?brain=work&day=Oct")).status).toBe(400);
    expect(await get("/api/memory/days")).toEqual([]);

    const work = (await (await call(owner, "POST", "/api/brains/work/tokens", {})).json<any>()).token as string;
    await call(work, "POST", "/memory/episodes", { session: "s1", transcript: '{"type":"user"}\n' });
    const episodes = await get("/api/memory/episodes?brain=work");
    expect(episodes.map((e: any) => e.session)).toEqual(["s1"]);
    expect((await get(`/api/memory/episodes/${episodes[0].id}?brain=work`)).transcript).toBe('{"type":"user"}\n');
    expect((await call(owner, "GET", `/api/memory/episodes/${"0".repeat(32)}?brain=work`)).status).toBe(404);

    expect((await get("/api/memory/recall?brain=work&q=PR%20191"))[0].day).toBe("2026-10-26");
    expect((await call(owner, "GET", "/api/memory/recall?brain=work")).status).toBe(400);
    expect((await call(assistant, "GET", "/api/memory/days?brain=work")).status).toBe(403);
  });
});

describe("consolidation", () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const line = (type: "user" | "assistant", text: string, when: string) => JSON.stringify({ type, timestamp: when, message: { content: [{ type: "text", text }] } });
  const day = (daysAgo: number) => new Date(Date.parse(`${today("America/Phoenix")}T12:00:00Z`) - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const memoryStub = () => env.MEMORY.get(env.MEMORY.idFromName(`${USER}/pepper`));

  it("renders a transcript as what was said, after a watermark", () => {
    const t = [
      line("user", "Book the dentist", "2026-10-30T10:00:00Z"),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-30T10:01:00Z", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cal" } }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-10-30T10:02:00Z", message: { content: [{ type: "tool_result", content: "a calendar" }] } }),
      line("assistant", "Booked for Friday.", "2026-10-30T10:03:00Z"),
      "not json",
    ].join("\n");
    const all = render(t);
    expect(all.through).toBe("2026-10-30T10:03:00Z");
    expect(all.text).toContain("USER (2026-10-30T10:00:00Z): Book the dentist");
    expect(all.text).toContain("[tool: Bash cal]");
    expect(all.text).not.toContain("a calendar");
    expect(render(t, "2026-10-30T10:02:00Z").text).toBe("AGENT (2026-10-30T10:03:00Z): Booked for Friday.");
  });

  it("takes bullets with what's nested under them, and NOTHING as none", () => {
    expect(bullets("- Chose X\n  - **Why:** Y\n- Learned Z")).toEqual(["Chose X\n  - **Why:** Y", "Learned Z"]);
    expect(bullets("NOTHING")).toEqual([]);
    expect(bullets("Preamble\n- One")).toEqual(["Preamble", "One"]);
  });

  it("refuses a rollup without its fence, too long, or throwing most away", () => {
    expect(parseRollup("no fence", "")).toEqual({ error: expect.stringMatching(/no ===MEMORY===/) });
    expect(parseRollup(`===MEMORY===\n${"x".repeat(20_001)}`, "")).toEqual({ error: expect.stringMatching(/over 20000/) });
    expect(parseRollup("===MEMORY===\nshort", "y".repeat(3000))).toEqual({ error: expect.stringMatching(/too much thrown away/) });
    expect(parseRollup("===MEMORY===\n```markdown\n# Memory\n```\n===SOUL-SUGGESTIONS===\n- Be terser", "")).toEqual({ memory: "# Memory\n", suggestions: ["Be terser"] });
  });

  it("writes an episode's bullets to the log, and reads a session on from where it left off", async () => {
    const pepper = await pepperToken();
    const first = [line("user", "Plan the trip", at(20)), line("assistant", "Chose Flagstaff", at(19))].join("\n") + "\n";
    await call(pepper, "POST", "/memory/episodes", { session: "s1", transcript: first });
    const job = await (await call(pepper, "GET", "/memory/consolidate")).json<any>();
    expect(job.rollup).toBeNull();
    expect(job.episodes).toHaveLength(1);
    expect(job.episodes[0].prompt).toMatch(/memory flush/);
    expect(job.episodes[0].input).toContain("Chose Flagstaff");
    const answered = await call(pepper, "POST", `/memory/consolidate/episodes/${job.episodes[0].id}`, { text: "- Chose Flagstaff for the trip\n  - **Why:** closer" });
    expect(await answered.json<any>()).toEqual({ entries: 1 });
    // Sent again, kept once.
    expect(await (await call(pepper, "POST", `/memory/consolidate/episodes/${job.episodes[0].id}`, { text: "- again" })).json<any>()).toEqual({ entries: 0 });
    const hits = await tool(pepper, "memory_grep", { text: "Flagstaff for the trip" });
    expect(hits).toHaveLength(1);
    expect((await (await call(pepper, "GET", "/memory/consolidate")).json<any>()).episodes).toEqual([]);

    await call(pepper, "POST", "/memory/episodes", { session: "s1", transcript: first + line("user", "Book the cabin too", at(5)) + "\n" });
    const next = await (await call(pepper, "GET", "/memory/consolidate")).json<any>();
    expect(next.episodes[0].input).toContain("Book the cabin too");
    expect(next.episodes[0].input).not.toContain("Chose Flagstaff\n");
    expect(next.episodes[0].input).not.toContain("Plan the trip");
  });

  it("lets go of an episode after three tries", async () => {
    const pepper = await pepperToken();
    await call(pepper, "POST", "/memory/episodes", { session: "s1", transcript: line("user", "hello", at(5)) + "\n" });
    for (let i = 0; i < 3; i++) expect((await (await call(pepper, "GET", "/memory/consolidate")).json<any>()).episodes).toHaveLength(1);
    expect((await (await call(pepper, "GET", "/memory/consolidate")).json<any>()).episodes).toEqual([]);
    expect(await (await call(pepper, "GET", "/memory/episodes?pending=1")).json<any[]>()).toEqual([]);
  });

  it("rewrites the long-term memory from the days since the last rollup", async () => {
    const pepper = await pepperToken();
    const was = "# Memory\n\n" + "- An old fact worth keeping.\n".repeat(100);
    expect((await call(owner, "PUT", "/api/notes/memory", { kind: "memory", title: "Long-term memory", body: was })).status).toBe(200);
    await call(owner, "POST", "/api/memory/entries", { entries: [{ day: day(1), at: at(24 * 60), key: "k1", who: "pepper", text: "Moved the dentist to Monday." }] });
    const job = await (await call(pepper, "GET", "/memory/consolidate")).json<any>();
    expect(job.rollup).toMatchObject({ through: day(1), version: 1 });
    expect(job.rollup.input).toContain("Moved the dentist to Monday.");
    expect(job.rollup.input).toContain("An old fact worth keeping.");

    const roll = (version: number, text: string) => call(pepper, "POST", "/memory/consolidate/rollup", { through: day(1), version, text });
    expect((await roll(1, "===MEMORY===\nTiny.")).status).toBe(422);
    expect((await roll(0, `===MEMORY===\n${was}`)).status).toBe(409);
    const ok = await roll(1, `===MEMORY===\n${was}- The dentist is on Mondays (${day(1)}).\n===SOUL-SUGGESTIONS===\n- Mention appointments a day ahead`);
    expect(ok.status).toBe(200);
    expect((await (await call(owner, "GET", "/api/notes/memory")).json<any>()).body).toContain("The dentist is on Mondays");
    expect(await tool(pepper, "memory_grep", { text: "Suggested for the soul" })).toHaveLength(1);
    expect((await (await call(pepper, "GET", "/memory/consolidate")).json<any>()).rollup).toBeNull();
    expect((await roll(2, `===MEMORY===\n${was}`)).status).toBe(409);
  });

  it("is spawned from the alarm once the episodes are quiet, one at a time, where a fleetd runs it", async () => {
    const pepper = await pepperToken();
    const templates = { coding: { needsApproval: true, memory: 4096, cores: 2, capNames: ["coding"] } };
    expect((await call(owner, "PUT", "/api/fleet/environments/local", { templates, jobs: ["consolidate"] })).status).toBe(200);
    // Smaller, so it would be placed there, but its fleetd doesn't say it runs jobs.
    const small = { "cloud-coding": { needsApproval: false, memory: 1536, cores: 1, capNames: ["coding"] } };
    expect((await call(owner, "PUT", "/api/fleet/environments/cloud", { templates: small })).status).toBe(200);
    await call(pepper, "POST", "/memory/episodes", { session: "s1", transcript: line("user", "hello", at(5)) + "\n" });
    const spawns = async () => (await (await call(owner, "GET", "/api/spawns")).json<any[]>()).filter((s) => s.job === "consolidate");

    // Not quiet yet.
    await runDurableObjectAlarm(memoryStub());
    expect(await spawns()).toEqual([]);

    await runInDurableObject(memoryStub(), (_o, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'consolidate_at'", String(Date.now() - 1000));
    });
    await runDurableObjectAlarm(memoryStub());
    const [made] = await spawns();
    expect(made).toMatchObject({ brain: "pepper", by: "memory", state: "queued", job: "consolidate", environment: "local" });
    await runInDurableObject(memoryStub(), (_o, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(memoryStub());
    expect(await spawns()).toHaveLength(1);
  });
});
