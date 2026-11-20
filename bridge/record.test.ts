// A meeting after it's recorded, as the Meetings tab drives it: `record
// finish`, `propose`, `accept` and `drop` (record.ts), run as the bridge
// runs them, in a process of their own, against this machine's node and a
// model both served here. The recording and the hearing need a microphone
// and the models; listen.test.ts hears made-up audio instead.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meeting } from "./record";

const DIR = mkdtempSync(join(tmpdir(), "corkboard-record-"));
const STATE = join(DIR, "state");
const OWNER = "owner-token-1";

// The node: its boards, the cards made on them, the notes sent to brains.
const made: { board: string; body: any }[] = [];
const notes: { path: string; body: any }[] = [];
const refuse = { note: false, board: "" };
let node: ReturnType<typeof Bun.serve>;
// The model: the items it proposes, and what it was shown.
let items: unknown = [];
const shown: string[] = [];
let model: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  node = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${OWNER}`) return Response.json({ error: "who?" }, { status: 401 });
      const p = new URL(req.url).pathname;
      if (p === "/api/node/boards") return Response.json([{ key: "proj", name: "Project" }, { key: "home", name: "Home" }]);
      if (p === "/api/node/boards/proj/cards" && req.method === "GET")
        return Response.json([
          { id: "TASK-1", title: "Old work", status: "ready", updated: "2026-11-01" },
          { id: "TASK-2", title: "Finished", status: "done", updated: "2026-11-02" },
        ]);
      if (p === "/api/node/boards/home/cards" && req.method === "GET") return Response.json([]);
      const board = p.match(/^\/api\/node\/boards\/([^/]+)\/cards$/)?.[1];
      if (board && req.method === "POST") {
        if (board === refuse.board) return Response.json({ error: `no board ${board}` }, { status: 404 });
        made.push({ board, body: await req.json() });
        return Response.json({ id: `TASK-${10 + made.length}` }, { status: 201 });
      }
      if (p.startsWith("/api/node/brains/") && req.method === "PUT") {
        if (refuse.note) return Response.json({ error: "the brain is locked" }, { status: 503 });
        notes.push({ path: p, body: await req.json() });
        return Response.json({});
      }
      return Response.json({ error: "no" }, { status: 404 });
    },
  });
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: { content: string }[] };
      shown.push(body.messages[1].content);
      if (items === "down") return new Response("overloaded", { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items }) } }] });
    },
  });
  // Where the recorder finds the node, as app.ts writes it.
  mkdirSync(join(STATE, "node"), { recursive: true });
  writeFileSync(join(STATE, "node", "session-mcp.json"), JSON.stringify({ mcpServers: { "corkboard-memory": { url: `http://localhost:${node.port}/mcp` } } }));
  writeFileSync(join(STATE, "node", "owner-token"), OWNER + "\n");
});
afterAll(() => {
  node.stop(true);
  model.stop(true);
  rmSync(DIR, { recursive: true, force: true });
});

// `corkboard-bridge record <args>`, its exit code and what it said.
async function record(...args: string[]) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "record", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CORKBOARD_STATE_DIR: STATE, CORKBOARD_DATA_DIR: join(DIR, "data"), CORKBOARD_CACHE_DIR: join(DIR, "cache"), CORKBOARD_PROPOSE_MODEL: `openai:small@http://localhost:${model.port}/v1` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
}

// A meeting as the recorder leaves it, stopped and heard.
let n = 0;
function meeting(o: Partial<Meeting> = {}) {
  const id = `2026-11-20T14-03-0${n++}`;
  const dir = join(DIR, "meetings", id);
  mkdirSync(dir, { recursive: true });
  const m: Meeting = {
    id,
    brain: "pepper",
    started: "2026-11-20T14:03:00.000Z",
    stopped: "2026-11-20T14:33:00.000Z",
    chunks: [],
    lines: [
      { track: "in", start: 5_000, stop: 8_000, text: "I'll send Alice the deck by Friday.", speaker: 0 },
      { track: "out", start: 65_000, stop: 70_000, text: "Can you look at the old work too?", speaker: 1 },
      { track: "in", start: 3_725_000, stop: 3_730_000, text: "Sure.", speaker: 1 },
    ],
    voices: { out: [], in: [] },
    who: { out: ["Them 1", "Them 2"], in: ["Me", "Room 1"] },
    partial: {},
    heard: { out: 70_000, in: 3_730_000 },
    transcribed: "2026-11-20T14:34:00.000Z",
    ...o,
  };
  writeFileSync(join(dir, "meeting.json"), JSON.stringify(m));
  return { dir, read: () => JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as Meeting };
}

const DECK = { title: "Send Alice the deck", description: "By Friday.", owner: "me", board: "proj", at: "[00:05]", quote: "I'll send Alice the deck by Friday." };
const LOOK = { title: "Look at the old work", description: "Relates to TASK-1.", owner: "Them 2", board: "nowhere", at: "[1:01:05]", quote: "Can you look at the old work too?" };

describe("record finish", () => {
  it("sends the transcript to the brain and proposes its action items", async () => {
    items = [DECK, { ...LOOK, owner: "  " }];
    const m = meeting();
    const r = await record("finish", m.dir);
    expect(r).toMatchObject({ code: 0 });
    const note = notes.at(-1)!;
    expect(note.path).toBe(`/api/node/brains/pepper/notes/meeting-${m.read().id.toLowerCase()}`);
    expect(note.body.kind).toBe("reference");
    expect(note.body.title).toStartWith("Meeting, ");
    expect(note.body.body).toContain("Recorded on this laptop for 30 min.");
    expect(note.body.body).toContain("[00:05] Me: I'll send Alice the deck by Friday.\n[01:05] Them 2: Can you look at the old work too?\n[1:02:05] Room 1: Sure.");
    // The model's shown the boards' open cards, and the transcript.
    expect(shown.at(-1)).toContain("## proj (Project)\n- TASK-1 [ready] Old work\n");
    expect(shown.at(-1)).not.toContain("Finished");
    expect(shown.at(-1)).toContain("## home (Home)\n(no open cards)");
    expect(shown.at(-1)).toContain("[00:05] Me: I'll send Alice");
    const after = m.read();
    expect(after.sent).toBeDefined();
    expect(after.proposed).toBeDefined();
    expect(after.pid).toBeUndefined();
    expect(after.boards).toEqual([{ key: "proj", name: "Project" }, { key: "home", name: "Home" }]);
    // A board it made up is none; an owner left blank is the user.
    expect(after.proposals).toEqual([
      { ...DECK, at: 5_000 },
      { ...LOOK, owner: "me", board: null, at: 3_665_000 },
    ]);
  }, 30_000);

  it("says nothing was said, and proposes nothing, for a silent meeting", async () => {
    const asked = shown.length;
    const m = meeting({ lines: [] });
    expect((await record("finish", m.dir)).code).toBe(0);
    expect(notes.at(-1)!.body.body).toContain("Nothing was said.");
    expect(shown.length).toBe(asked);
    expect(m.read().proposals).toBeUndefined();
  }, 30_000);

  it("keeps the meeting when the brain can't take it, and sends it the next time", async () => {
    items = [DECK];
    refuse.note = true;
    const m = meeting();
    expect((await record("finish", m.dir)).code).toBe(0);
    expect(m.read()).toMatchObject({ failed: "sending to pepper: the brain is locked" });
    expect(m.read().sent).toBeUndefined();
    expect(m.read().proposals!.length).toBe(1);
    refuse.note = false;
    const asked = shown.length;
    expect((await record("finish", m.dir)).code).toBe(0);
    expect(m.read().sent).toBeDefined();
    expect(m.read().failed).toBeUndefined();
    // Proposed already, it isn't again.
    expect(shown.length).toBe(asked);
  }, 30_000);

  it("refuses a meeting still being recorded, or one another process is on", async () => {
    expect(await record("finish", meeting({ stopped: undefined }).dir)).toMatchObject({ code: 1, err: "it's still being recorded" });
    expect(await record("finish", meeting({ pid: process.pid }).dir)).toMatchObject({ code: 1, err: "it's being transcribed" });
    // A pid that's gone is no one's.
    expect((await record("finish", meeting({ pid: 2 ** 22 + 7 }).dir)).code).toBe(0);
  }, 30_000);
});

describe("record propose, accept and drop", () => {
  it("proposes again, keeping what's a card already", async () => {
    items = [DECK, LOOK];
    const m = meeting();
    await record("finish", m.dir);
    expect((await record("accept", m.dir, JSON.stringify([{ i: 0, board: "home", title: "  " }]))).code).toBe(0);
    items = [{ ...LOOK, title: "Look again", board: "home" }];
    expect((await record("propose", m.dir)).code).toBe(0);
    expect(m.read().proposals!.map((p) => [p.title, p.card ?? null])).toEqual([
      ["Send Alice the deck", `home/TASK-${10 + made.length}`],
      ["Look again", null],
    ]);
  }, 30_000);

  it("makes picked proposals cards, quoting where in the meeting they came from", async () => {
    items = [DECK, LOOK];
    const m = meeting();
    await record("finish", m.dir);
    const before = made.length;
    const r = await record("accept", m.dir, JSON.stringify([{ i: 0, board: "proj", title: "Deck to Alice" }, { i: 1, board: "home" }, { i: 9, board: "proj" }]));
    expect(r.code).toBe(0);
    expect(made.slice(before).map((c) => [c.board, c.body.title, c.body.status])).toEqual([
      ["proj", "Deck to Alice", "backlog"],
      ["home", "Look at the old work", "backlog"],
    ]);
    const [deck, look] = made.slice(before).map((c) => c.body.description as string);
    expect(deck).toStartWith("By Friday.\n\nFrom the meeting on ");
    expect(deck).toContain(", at 00:05:\n\n> I'll send Alice the deck by Friday.");
    expect(look).toContain(", at 1:01:05 (for Them 2):\n\n> Can you look at the old work too?");
    const p = m.read().proposals!;
    expect(p.map((x) => [x.title, x.board, x.card])).toEqual([
      ["Deck to Alice", "proj", `proj/TASK-${10 + before + 1}`],
      ["Look at the old work", "home", `home/TASK-${10 + before + 2}`],
    ]);
    // Accepted again, nothing's made twice.
    expect((await record("accept", m.dir, JSON.stringify([{ i: 0, board: "proj" }]))).code).toBe(0);
    expect(made.length).toBe(before + 2);
  }, 30_000);

  it("makes the cards it can and says which it couldn't", async () => {
    items = [DECK, LOOK];
    const m = meeting();
    await record("finish", m.dir);
    refuse.board = "gone";
    const r = await record("accept", m.dir, JSON.stringify([{ i: 0, board: "gone" }, { i: 1, board: "proj" }]));
    refuse.board = "";
    expect(r).toMatchObject({ code: 1, err: "Send Alice the deck: no board gone" });
    expect(m.read().proposals!.map((x) => x.card ?? null)).toEqual([null, expect.stringMatching(/^proj\//)]);
  }, 30_000);

  it("drops a proposal, but not one that's a card", async () => {
    items = [DECK, LOOK];
    const m = meeting();
    await record("finish", m.dir);
    await record("accept", m.dir, JSON.stringify([{ i: 1, board: "proj" }]));
    expect((await record("drop", m.dir, "0")).code).toBe(0);
    expect((await record("drop", m.dir, "1")).code).toBe(0);
    expect((await record("drop", m.dir, "7")).code).toBe(0);
    const p = m.read().proposals!;
    expect([p[0].dropped, p[1].dropped]).toEqual([true, undefined]);
  }, 30_000);

  it("says why it couldn't propose, keeping what it had", async () => {
    items = [DECK];
    const m = meeting();
    await record("finish", m.dir);
    items = "down";
    const r = await record("propose", m.dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("503");
    expect(m.read().unproposed).toContain("503");
    expect(m.read().proposals!.map((x) => x.title)).toEqual(["Send Alice the deck"]);
    expect(m.read().pid).toBeUndefined();
    // Nor one not yet transcribed, nor any while another process is on it.
    expect(await record("propose", meeting({ transcribed: undefined }).dir)).toMatchObject({ code: 1, err: "it isn't transcribed yet" });
    expect(await record("propose", meeting({ pid: process.pid }).dir)).toMatchObject({ code: 1, err: "it's being transcribed" });
    expect(await record("accept", meeting({ pid: process.pid }).dir, "[]")).toMatchObject({ code: 1, err: "it's being transcribed" });
  }, 30_000);

  it("answers what isn't an op with its usage", async () => {
    expect(await record("nonsense")).toMatchObject({ code: 2, err: expect.stringContaining("usage: corkboard-bridge record") });
    expect(await record("status")).toMatchObject({ code: 0, out: "null" });
    expect(await record("stop")).toMatchObject({ code: 0, out: "not recording" });
  }, 30_000);
});
