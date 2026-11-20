// Card files as cards.ts reads and writes them: Backlog.md's format, round
// and round again, the per-card locks with writers in other processes, and
// what a card waits on. CORKBOARD_BOARD is read when cards.ts loads, so it
// is set first and the module imported after.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Gen, fuzz } from "../lib/testing/fuzz";

const BOARD = mkdtempSync(join(tmpdir(), "corkboard-cards-"));
afterAll(() => rmSync(BOARD, { recursive: true, force: true }));
process.env.CORKBOARD_BOARD = BOARD;
const { STATUSES, appendLog, change, create, find, list, parse, sections, serialize, split, waitingOn, wellFormed } = await import("./cards");
type Card = import("./cards").Card;

const TASKS = join(BOARD, "tasks");
const REPO = join(import.meta.dir, "..");

// A card file of the given text, beside the board's, for parse.
let files = 0;
const file = (text: string, name = `task-${900 + files++} - Odd.md`) => {
  const dir = join(BOARD, "odd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
};
// serialize, written, and parsed back.
const again = (card: Card) => parse(file(serialize(card)))!;

describe("a card's file", () => {
  it("is Backlog.md's: its keys in its order, then the rest sorted, then the body", () => {
    const c = create("Ship the board", "What and why.", "ready", { priority: "high", labels: ["ui"], worktree: "/w", branch: "b" });
    const text = readFileSync(c.path, "utf8");
    expect(c.path).toBe(join(TASKS, "task-1 - Ship-the-board.md"));
    const keys = text.split("\n---\n")[0].split("\n").slice(1).filter((l) => !l.startsWith(" ")).map((l) => l.split(":")[0]);
    expect(keys).toEqual(["id", "title", "status", "assignee", "created_date", "updated_date", "labels", "dependencies", "priority", "branch", "worktree"]);
    expect(text).toContain("labels:\n  - ui\n");
    expect(text).toContain("dependencies: []\n");
    // Backlog.md's dates are quoted, so YAML keeps them strings.
    expect(text).toMatch(/created_date: '\d{4}-\d\d-\d\d \d\d:\d\d'/);
    expect(split(find("task-1").body)).toEqual({ description: "What and why.\n", log: "" });
  });

  it("keeps as strings what YAML would read as something else", () => {
    const odd = ["true", "No", "null", "~", "123", "1.5", "2026-11-20", "-x", "a: b", "a #b", "#x", "x:", "[a]", "{a: 1}", "'q'", '"q"', "*ref", "&a", "!tag", "|", ">", "%x", "@me", "`x`", " lead", "trail "];
    const c = again({ id: "TASK-900", path: "", body: "", title: "T", status: "ready", labels: odd, branch: "123", agent: "true" } as unknown as Card);
    expect(c.labels).toEqual(odd);
    expect(c.branch).toBe("123");
    expect(c.agent).toBe("true");
    expect(c.assignee).toEqual(["true"]);
  });

  it("keeps a card whose field has a line break or a control character in it", () => {
    // Single quotes fold a line break to a space, and a bare one, a NUL or a
    // CR made the front matter unreadable: the card read back with no
    // fields, and the next change wrote it so, its title and status gone.
    const c = create("Kept", "", "doing");
    const odd = ["a\nb: c", "nul\0", "cr\rlf", "nel\u0085", "ls\u2028", 'back\\slash "q"', "1e3", ".inf", "0x1f"];
    change(c.id, (card) => void (card.labels = odd));
    change(c.id, (card) => void (card.attention = "two\nlines"));
    const back = find(c.id);
    expect([back.title, back.status, back.attention]).toEqual(["Kept", "doing", "two\nlines"]);
    expect(back.labels).toEqual(odd);
    // A key YAML would read as a number stays the key it was.
    expect(again({ ...back, "1e309": "x" } as Card)["1e309"]).toBe("x");
  });

  it("reads what Backlog.md and people write: flow lists, a scalar for a list, @names, a number", () => {
    const c = parse(
      file("---\nid: task-7\ntitle: Seven\nstatus: doing\nassignee: '@bob'\nlabels: [a, 'b, c']\ndependencies: task-1\nordinal: 2.5\nempty:\n---\nBody\n", "task-7 - Seven.md"),
    )!;
    expect([c.id, c.title, c.status, c.agent, c.ordinal]).toEqual(["task-7", "Seven", "doing", "bob", "2.5"]);
    expect(c.assignee).toEqual(["@bob"]);
    expect(c.labels).toEqual(["a", "b, c"]);
    expect(c.dependencies).toEqual(["task-1"]);
    expect(c.empty).toBeUndefined();
    expect(c.body).toBe("Body\n");
    // The second assignee onward stays as it was; the agent is the first.
    expect(again({ ...c, agent: "ann" }).assignee).toEqual(["ann"]);
    expect(again({ ...c, assignee: ["@bob", "carol"], agent: "ann" }).assignee).toEqual(["ann", "carol"]);
    // An ordinal is written as the number it is.
    expect(serialize({ ...c })).toContain("ordinal: 2.5\n");
  });

  it("takes a file with no front matter, or half of one, as a card with no fields", () => {
    const none = parse(file("Just a note.\n", "task-31 - Note.md"))!;
    expect([none.id, none.title, none.status, none.body]).toEqual(["TASK-31", "TASK-31", "backlog", "Just a note.\n"]);
    const half = parse(file("---\ntitle: [unclosed\nstatus: done\n---\nBody\n", "task-32 - Half.md"))!;
    expect([half.id, half.title, half.status, half.body]).toEqual(["TASK-32", "TASK-32", "backlog", "Body\n"]);
    const odd = parse(file("---\nid: x\nstatus: nonsense\n---\n", "notes.md"))!;
    expect([odd.id, odd.status, odd.body]).toEqual(["x", "backlog", ""]);
    expect(parse(join(BOARD, "odd", "missing.md"))).toBeUndefined();
  });

  it("keeps fields it doesn't know, named like an Object's own, as data", () => {
    const c = parse(file("---\nid: TASK-40\ntitle: T\n__proto__: p\nconstructor: c\ntoString: s\npr: 12\n---\n", "task-40 - T.md"))!;
    expect(Object.getPrototypeOf(c)).toBeNull();
    expect([c.__proto__, c.constructor, c.toString, c.pr]).toEqual(["p", "c", "s", "12"]);
    const back = again(c);
    expect([back.__proto__, back.constructor, back.toString, back.pr]).toEqual(["p", "c", "s", "12"]);
  });

  it("keeps a body's unicode, blank sections and all, as it was", () => {
    const body = "\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n\n中文 😀 ---\n---\n\n\n";
    const c = again({ id: "TASK-41", path: "", body, title: "中文 😀", status: "done" } as unknown as Card);
    expect([c.title, c.body]).toEqual(["中文 😀", body]);
    expect(split(c.body)).toEqual({ description: "", log: "" });
  });
});

describe("a card's description and log", () => {
  it("splits into the two sections, or at the heading without markers", () => {
    expect(split(sections("Do it.\n", "- a note\n"))).toEqual({ description: "Do it.\n", log: "- a note\n" });
    expect(split("Plain text\n## Implementation Notes\n- by hand\n")).toEqual({ description: "Plain text\n", log: "" });
    expect(split("")).toEqual({ description: "", log: "" });
  });

  it("logs inside the notes' markers, its continuation lines indented", () => {
    const c = { id: "TASK-1", path: "", body: sections("D", "") } as Card;
    appendLog(c, "ann", "first");
    appendLog(c, "bob", "two\nlines\n");
    const { log } = split(c.body);
    expect(log).toMatch(/^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ann: first\n- \S+ bob: two\n  lines\n$/);
    expect(split(c.body).description).toBe("D\n");
  });

  it("gives a body with no notes section one", () => {
    const c = { id: "TASK-1", path: "", body: "Hand-written.\n\n\n" } as Card;
    appendLog(c, "ann", "noted");
    expect(c.body).toStartWith("Hand-written.\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n- ");
    expect(split(c.body).log).toContain("ann: noted");
  });
});

describe("the board", () => {
  it("numbers cards past the highest, and lists them by priority, ordinal, then number", () => {
    const low = create("Low", "", "backlog", { priority: "low" });
    const a = create("A");
    const b = create("B", "", "ready", { ordinal: "1" } as Partial<Card>);
    const weird = create("Weird priority", "", "backlog", { priority: "constructor" });
    expect(Number(a.id.slice(5))).toBe(Number(low.id.slice(5)) + 1);
    // TASK-1 is high; b's ordinal puts it ahead of the mediums without one,
    // a priority it doesn't know is medium, and low is last.
    const mine = new Set(["TASK-1", low.id, a.id, b.id, weird.id]);
    expect(list().map((c) => c.id).filter((id) => mine.has(id))).toEqual(["TASK-1", b.id, a.id, weird.id, low.id]);
    expect(() => create("X", "", "nonsense")).toThrow("status must be one of");
  });

  it("finds a card by its id in any case, and refuses ids that aren't ids", () => {
    expect(find("TASK-1").title).toBe("Ship the board");
    expect(find("task-1").id).toBe("TASK-1");
    expect(() => find("TASK-999")).toThrow("no card TASK-999");
    expect(() => find("../etc")).toThrow("bad card id");
    expect(() => find("constructor")).toThrow("bad card id");
  });

  it("changes a card under its lock, its updated date moved on, the lock let go", () => {
    const c = create("Changed");
    const out = change(c.id, (card) => void (card.status = "doing"));
    expect(out.status).toBe("doing");
    expect(find(c.id).status).toBe("doing");
    expect(readdirSync(TASKS).filter((n) => n.endsWith(".lock") || n.endsWith(".tmp"))).toEqual([]);
    // A change that throws writes nothing and still lets the lock go.
    expect(() => change(c.id, (card) => ((card.status = "done"), (() => { throw new Error("no"); })()))).toThrow("no");
    expect(find(c.id).status).toBe("doing");
    expect(readdirSync(TASKS).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("waits on what isn't done, and on ids with no card", () => {
    const done = create("Done", "", "done");
    const open = create("Open");
    const c = create("Waits", "", "backlog", { dependencies: [done.id, open.id.toLowerCase(), "TASK-404"] });
    expect(waitingOn(c)).toEqual([open.id, "TASK-404 (no such card)"]);
    expect(waitingOn({ ...c, dependencies: undefined } as unknown as Card)).toEqual([]);
  });
});

// A process of its own, writing the board as another agent would.
const worker = (code: string) =>
  Bun.spawn(["bun", "-e", `const c = await import(${JSON.stringify(join(REPO, "mcp", "cards.ts"))});\n${code}`], {
    cwd: REPO,
    env: { ...process.env, CORKBOARD_BOARD: BOARD },
    stdout: "pipe",
    stderr: "pipe",
  });
const finished = async (p: ReturnType<typeof worker>) => {
  const code = await p.exited;
  const out = await new Response(p.stdout).text();
  if (code) throw new Error(`a worker exited ${code}: ${await new Response(p.stderr).text()}`);
  return out;
};

describe("writers in other processes", () => {
  it("lose none of each other's log entries", async () => {
    const c = create("Contended");
    const writers = Array.from({ length: 4 }, (_, w) =>
      worker(`for (let i = 0; i < 10; i++) c.change(${JSON.stringify(c.id)}, (card) => c.appendLog(card, "w${w}", "entry " + i));`),
    );
    await Promise.all(writers.map(finished));
    const log = split(find(c.id).body).log;
    for (let w = 0; w < 4; w++) for (let i = 0; i < 10; i++) expect(log).toContain(`w${w}: entry ${i}\n`);
    expect(log.trim().split("\n").length).toBe(40);
  }, 30_000);

  it("never take the same id", async () => {
    const before = list().length;
    const made = await Promise.all(Array.from({ length: 4 }, () => finished(worker(`for (let i = 0; i < 5; i++) console.log(c.create("Raced").id);`))));
    const ids = made.join("").trim().split("\n");
    expect(new Set(ids).size).toBe(20);
    expect(list().length).toBe(before + 20);
  }, 30_000);

  it("wait out a lock someone holds, then give up", () => {
    const c = create("Held");
    const lock = join(TASKS, `.${c.id}.lock`);
    mkdirSync(lock);
    const t = Date.now();
    expect(() => change(c.id, () => {})).toThrow(`card ${c.id} is busy; try again`);
    expect(Date.now() - t).toBeGreaterThanOrEqual(2900);
    // Older than ten seconds, it's a dead process's, and taken.
    utimesSync(lock, new Date(Date.now() - 11_000), new Date(Date.now() - 11_000));
    expect(change(c.id, (card) => void (card.title = "Taken")).title).toBe("Taken");
  }, 10_000);
});

// A card as cards.ts could be given one: any field, any value, any body.
const KNOWN = ["title", "status", "priority", "ordinal", "agent_state", "attention", "worktree", "branch", "pr", "budget_hold"];
function card(g: Gen, n: number): Card {
  const c = { id: `TASK-${n}`, path: "", body: g.bool(0.2) ? g.pick(["", "\n", "---\n---\n"]) : wellFormed(g.string(80)) } as Card;
  for (let k = g.size(8); k > 0; k--) {
    const key = wellFormed(g.key(KNOWN));
    if (["id", "path", "body", "agent", "assignee", "labels", "dependencies"].includes(key)) continue;
    c[key] = key === "ordinal" ? String(g.int(-100, 100)) : key === "status" ? g.pick(STATUSES) : value(g);
  }
  c.title ||= value(g) || "T";
  c.status = STATUSES.includes(c.status) ? c.status : "backlog";
  c.labels = Array.from({ length: g.size(4) }, () => value(g));
  c.dependencies = Array.from({ length: g.size(3) }, () => `TASK-${g.int(1, 99)}`);
  if (g.bool()) c.agent = value(g).replace(/^@+/, "") || "a";
  return c;
}
// Any value, line breaks and control characters too; well-formed, as a
// file's UTF-8 must be (half a surrogate pair is written as U+FFFD).
const ODD = ["a\nb", "\0", "x\r\ny", "\u0085", "\u2028", "\ufeff", "1e3", ".inf", "0x1f", 'a\\n"b'];
const value = (g: Gen) => wellFormed(g.bool(0.2) ? g.pick(ODD) : g.string(24));

describe("cards, fuzzed", () => {
  fuzz("come back from their file as they went in", (g, seed) => {
    const c = card(g, 1000 + seed);
    const back = again(c);
    const fields = (x: Card) => Object.fromEntries(Object.entries(x).filter(([k, v]) => k !== "path" && v !== "" && v !== undefined));
    const want = fields(c);
    want.assignee = c.agent ? [c.agent] : [];
    if (!c.agent) delete want.agent;
    const got = fields(back);
    if (!c.agent) delete got.agent;
    expect(got).toEqual(want);
    // And written again, the same file.
    expect(serialize(back)).toBe(serialize({ ...c, assignee: want.assignee }));
  });

  fuzz("read any front matter without throwing", (g) => {
    const lines = Array.from({ length: g.size(8) }, () => `${g.key(KNOWN)}: ${g.string(12)}`);
    const c = parse(file(`---\n${lines.join("\n")}\n---\n${g.string(20)}`, `task-${g.int(1, 9)} - F.md`))!;
    expect(STATUSES).toContain(c.status);
    expect(typeof c.title).toBe("string");
    // Whatever it read, it writes as a file it reads again.
    expect(STATUSES).toContain(again(c).status);
  });
});
