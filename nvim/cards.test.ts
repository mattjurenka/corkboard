// Card files as corkboard.cards reads and writes them, against mcp/cards.ts,
// its TypeScript twin: each must write byte for byte what the other would,
// and read back what the other wrote. Then the board's own operations on
// them (create, set, log, list, the locks) in a real Neovim.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "../lib/dict";
import { fuzz } from "../lib/testing/fuzz";
import { type Card, STATUSES, appendLog, parse, serialize, wellFormed } from "../mcp/cards";
import { sandbox } from "./testing";

const box = sandbox({ repo: false });
afterAll(() => box.cleanup());
const board = join(box.dir, "board");
const tasks = join(board, "tasks");
const env = { CORKBOARD_BOARD: board };
const lua = <T = any>(code: string, input?: unknown) => box.lua<T>(`local cards = require("corkboard.cards")\n${code}`, input, { env });

// A card's fields as [key, value] pairs, lists as arrays: a Lua table and a
// Dict both from them, in this order.
type Fields = [string, string | string[]][];
const BODY = "\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nWhat to do.\n<!-- SECTION:DESCRIPTION:END -->\n";

// As parse() leaves a card: a status, and its first assignee its agent.
function tsCard(path: string, fields: Fields): Card {
  const card: Card = Object.assign(dict<any>(), { id: "", path, body: BODY, status: "backlog" }, dict(fields));
  if (card.assignee) card.agent = card.assignee[0]?.replace(/^@/, "") || undefined;
  return card;
}

// Each card serialized by Lua, and the file TS wrote for it read by Lua and
// serialized again.
function luaSide(cases: { path: string; fields: Fields }[]): { wrote: string; reread: string }[] {
  return lua(
    `local out = {}
    for _, c in ipairs(input.cases) do
      local card = { path = c.path, body = input.body, status = "backlog" }
      for _, kv in ipairs(c.fields) do card[kv[1]] = kv[2] end
      local agent = card.assignee and card.assignee[1] and card.assignee[1]:gsub("^@", "")
      card.agent = agent ~= "" and agent or nil
      table.insert(out, { wrote = cards.serialize(card), reread = cards.serialize(cards.parse(c.path)) })
    end
    return out`,
    { cases, body: BODY },
  );
}

describe("the same file from both", () => {
  const fields: Fields[] = [
    [["id", "TASK-1"], ["title", "Render ext_cmdline as HTML"], ["status", "doing"], ["assignee", ["claude", "codex"]], ["agent_state", "working"]],
    // Each of these YAML would read as something else, unquoted.
    [["id", "TASK-2"], ["title", "Fix: the board"], ["status", "ready"], ["labels", ["ui", "- dash", "#hash"]], ["attention", "it's 'quoted'"]],
    [["id", "TASK-3"], ["title", "2026"], ["priority", "high"], ["ordinal", "4"], ["dependencies", ["TASK-1", "TASK-2"]]],
    [["id", "TASK-4"], ["title", "true"], ["created_date", "2026-11-20 10:30"], ["updated_date", "2026-11-20 10:31"], ["attention", "a # comment"]],
    [["id", "TASK-5"], ["title", " leading and trailing "], ["labels", []], ["worktree", "/home/me/wt"], ["branch", "agent/task-5/work"], ["pr", "12"]],
    [["id", "TASK-6"], ["title", "日本語のカード ✓"], ["budget_hold", "over: $5.00"], ["over_budget", "card:5"], ["zeta", "last"], ["alpha", "before zeta"]],
    [["id", "TASK-7"], ["title", "yes"], ["ordinal", "1.5"], ["attention", "~"], ["agent_state", "needs-review"]],
    // YAML's numbers that aren't plain digits: unquoted, mcp/cards.ts read
    // "0x1F" back as "31".
    [["id", "TASK-8"], ["title", "0x1F"], ["labels", ["1e3", "-2.5E-3", "0o17", ".inf", "-.Inf", ".NaN", "e3", "1e"]], ["attention", "NULL"]],
    // An ordinal that isn't the number YAML would read it as stays text.
    ...["1.50", " ", "0x10", "007", "-0", "1e3", "Infinity", "12345678901234567"].map((o, i): Fields => [["id", `TASK-${20 + i}`], ["title", `ordinal ${JSON.stringify(o)}`], ["ordinal", o]]),
    // What YAML doesn't print, in double quotes: bare, any of them made the
    // front matter unreadable, a card with no fields.
    [["id", "TASK-30"], ["title", "two\nlines"], ["attention", "nul\0 cr\r del\x7f c1\x85 ￾ \"q\" \\"], ["labels", ["a\nb", "\t"]], ["key\nbreak", "v"]],
    // A no-break space is no space to YAML, nor to Lua's %s.
    [["id", "TASK-9"], ["title", " no-break "], ["labels", [" "]]],
  ];
  const cases = fields.map((f, i) => ({ path: join(box.dir, `same-${i}.md`), fields: f }));
  for (const c of cases) writeFileSync(c.path, serialize(tsCard(c.path, c.fields)));
  const got = luaSide(cases);

  test.each(cases.map((c, i) => [c.fields[1][1], i] as const))("%s", (_, i) => {
    const file = readFileSync(cases[i].path, "utf8");
    expect(got[i].wrote).toBe(file);
    expect(got[i].reread).toBe(file);
    // And TS reads back what both wrote, each field as it was.
    const read = parse(cases[i].path)!;
    expect(serialize(read)).toBe(file);
    for (const [k, v] of cases[i].fields) expect([k, read[k]]).toEqual([k, v]);
  });

  test("the keys in Backlog.md's order, then the rest by name", () => {
    expect(got[5].wrote.split("\n").map((l) => l.split(":")[0])).toEqual(["---", "id", "title", "status", "assignee", "alpha", "budget_hold", "over_budget", "zeta", "---", "", "## Description", "", "<!-- SECTION", "What to do.", "<!-- SECTION", ""]);
  });

  test("the first assignee is the card's agent", () => {
    const card = lua(`local c = cards.parse(input) return { agent = c.agent, assignee = c.assignee }`, cases[0].path);
    expect(card).toEqual({ agent: "claude", assignee: ["claude", "codex"] });
    const moved = lua(`local c = cards.parse(input) c.agent = "opencode" return cards.serialize(c)`, cases[0].path);
    expect(moved).toContain("assignee:\n  - opencode\n  - codex\n");
  });
});

// What Backlog.md and people write by hand, that neither side writes.
describe("YAML written by others", () => {
  const files = {
    "flow lists": "---\nid: TASK-9\ntitle: Flow\nlabels: [a, 'b, c', \"d\"]\ndependencies: [TASK-1]\n---\nbody",
    "quoted scalars": "---\nid: TASK-9\ntitle: 'it''s'\nattention: \"say \\\"hi\\\"\"\n---\n",
    "a bare dash and an @": "---\nid: TASK-9\ntitle: Dash\nassignee:\n  - '@claude'\n  -\n---\n",
    // Not only the \n and \t that cards.lua read before: \u0000 was u0000.
    escapes: '---\nid: TASK-9\ntitle: "nul\\u0000 cr\\r x\\x41 \\U0001F600 \\ud83d\\ude00 bell\\a \\\\ \\" \\/ \\e"\n---\n',
    "quoted keys": "---\nid: TASK-9\ntitle: Keys\n'it''s': one\n\"tab\\tkey\": two\n'yes': three\n---\n",
    "a list as one value": "---\nid: TASK-9\ntitle: One\nlabels: solo\n---\n",
    "no front matter": "just a body\n",
  };
  for (const [name, text] of Object.entries(files)) {
    test(name, () => {
      const path = join(box.dir, `task-9 - ${name.replaceAll(" ", "-")}.md`);
      writeFileSync(path, text);
      const theirs = parse(path)!;
      const ours = lua(`local c = cards.parse(input) c.path = nil return c`, path);
      for (const k of ["id", "title", "status", "labels", "dependencies", "attention", "agent", "body", "it's", "tab\tkey", "yes"]) {
        // Lua's JSON has no empty list, only an empty object.
        const v = ours[k] && typeof ours[k] === "object" && !Array.isArray(ours[k]) && !Object.keys(ours[k]).length ? [] : ours[k];
        expect([k, v]).toEqual([k, theirs[k]]);
      }
    });
  }

  // Which Bun's YAML refuses, and nobody writes.
  test("half a surrogate pair is U+FFFD", () => {
    const path = join(box.dir, "task-9 - half.md");
    writeFileSync(path, '---\nid: TASK-9\ntitle: "a\\ud800b \\udc00"\n---\n');
    expect(lua(`return cards.parse(input).title`, path)).toBe("a\ufffdb \ufffd");
  });
});

// Cards with any fields: any keys, the nasty ones among them, and any values,
// line breaks and NULs too (half a surrogate pair is U+FFFD in a file, so it
// is one here).
fuzz(
  "any card, written by either, the same",
  (g, seed) => {
    const keys = ["assignee", "labels", "dependencies", "priority", "ordinal", "attention", "worktree"];
    const line = () => wellFormed(g.string(24));
    const cases = Array.from({ length: 12 }, (_, i) => {
      // A title and a status, as parse() gives a card without them some.
      const fields: Fields = [["id", `TASK-${i + 1}`], ["title", line().trim() || "t"], ["status", g.pick(STATUSES)]];
      const seen = new Set(["id", "title", "status", "path", "body", "agent"]);
      for (let n = g.int(0, 6); n > 0; n--) {
        const k = wellFormed(g.key(keys));
        if (seen.has(k)) continue;
        seen.add(k);
        // An assignee with no name is no agent, and goes; an @ is taken off.
        const item = k === "assignee" ? () => line().replace(/^@+/, "") || "a" : line;
        fields.push([k, ["assignee", "labels", "dependencies"].includes(k) ? Array.from({ length: g.int(0, 3) }, item) : line()]);
      }
      return { path: join(box.dir, `fuzz-${seed}-${i}.md`), fields };
    });
    for (const c of cases) writeFileSync(c.path, serialize(tsCard(c.path, c.fields)));
    const got = luaSide(cases);
    cases.forEach((c, i) => {
      const file = readFileSync(c.path, "utf8");
      expect(got[i].wrote).toBe(file);
      expect(got[i].reread).toBe(file);
      const read = parse(c.path)!;
      expect(serialize(read)).toBe(file);
      for (const [k, v] of c.fields) if (v !== "") expect([k, read[k]]).toEqual([k, v]);
    });
  },
  { runs: 15 },
);

describe("the board", () => {
  test("create numbers past the highest, sets up the board for the backlog CLI, and names the file from the title", () => {
    const ids = lua(`return { cards.create("First card", "ready", "Do it."), cards.create("Second: the sequel!", nil, "") }`);
    expect(ids).toEqual(["TASK-1", "TASK-2"]);
    expect(readdirSync(tasks).sort()).toEqual(["task-1 - First-card.md", "task-2 - Second-the-sequel.md"]);
    expect(readFileSync(join(board, "config.yml"), "utf8")).toContain("statuses: [backlog, ready, doing, review, done]");
    expect(existsSync(join(board, "README.md"))).toBe(true);
    const first = parse(join(tasks, "task-1 - First-card.md"))!;
    expect(first).toMatchObject({ id: "TASK-1", title: "First card", status: "ready", labels: [], dependencies: [] });
    expect(first.body).toContain("<!-- SECTION:DESCRIPTION:BEGIN -->\nDo it.\n<!-- SECTION:DESCRIPTION:END -->");
    expect(parse(join(tasks, "task-2 - Second-the-sequel.md"))!.status).toBe("backlog");
    // A gap, and a card from another prefix, don't make a duplicate.
    writeFileSync(join(tasks, "task-7 - Seven.md"), "---\nid: TASK-7\ntitle: Seven\n---\n");
    expect(lua(`return cards.create("After seven")`)).toBe("TASK-8");
  });

  test("set merges fields, an empty string clears one, and updated_date moves", () => {
    const card = lua(`
      cards.set("TASK-1", { attention = "look", priority = "high", worktree = "/wt" })
      cards.set("task-1", { attention = "" })
      local c = cards.get("TASK-1")
      return { attention = c.attention or vim.NIL, priority = c.priority, worktree = c.worktree, updated = c.updated_date }`);
    expect(card).toEqual({ attention: null, priority: "high", worktree: "/wt", updated: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) });
    expect(readFileSync(join(tasks, "task-1 - First-card.md"), "utf8")).not.toContain("attention");
  });

  test("log appends to the notes, inside their markers, continuation lines indented", () => {
    const notes = lua(`
      cards.log("TASK-1", "claude", "started")
      cards.log("TASK-1", "claude", "two\\nlines")
      return cards.section(cards.get("TASK-1"), "NOTES")`);
    expect(notes).toMatch(/^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ claude: started\n- \S+ claude: two\n  lines$/);
    const body = parse(join(tasks, "task-1 - First-card.md"))!.body;
    expect(body.indexOf("claude: two")).toBeLessThan(body.indexOf("<!-- SECTION:NOTES:END -->"));
  });

  test("a log entry where mcp/cards.ts puts it", () => {
    const bodies = [
      "",
      "Just text.",
      "Just text.\n\n\n",
      "\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n<!-- SECTION:NOTES:END -->\n",
      "<!-- SECTION:NOTES:BEGIN -->\n- 2026-01-01T00:00:00Z a: one\n\n\n<!-- SECTION:NOTES:END -->\ntail <!-- SECTION:NOTES:END -->",
    ];
    const ours: string[] = lua(
      `return vim.tbl_map(function(b) local c = { body = b } cards.append_log(c, "me", " a\\nb ") return c.body end, input)`,
      bodies,
    );
    const time = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g;
    bodies.forEach((body, i) => {
      const card = tsCard("", []);
      card.body = body;
      appendLog(card, "me", " a\nb ");
      expect(ours[i].replace(time, "T")).toBe(card.body.replace(time, "T"));
    });
  });

  test("a card with no notes section gets one", () => {
    writeFileSync(join(tasks, "task-20 - Bare.md"), "---\nid: TASK-20\ntitle: Bare\n---\nJust text.\n");
    expect(lua(`cards.log("TASK-20", "me", "hi") return cards.section(cards.get("TASK-20"), "NOTES")`)).toMatch(/me: hi$/);
    expect(readFileSync(join(tasks, "task-20 - Bare.md"), "utf8")).toContain("Just text.\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n- ");
  });

  test("set_description keeps a % as it is, and adds the section to a body without one", () => {
    const got = lua(`
      local c = { body = "\\n## Description\\n\\n<!-- SECTION:DESCRIPTION:BEGIN -->\\nold\\n<!-- SECTION:DESCRIPTION:END -->\\n" }
      cards.set_description(c, "100%1 done %%")
      local bare = { body = "notes" }
      cards.set_description(bare, "new")
      return { cards.section(c, "DESCRIPTION"), bare.body }`);
    expect(got[0]).toBe("100%1 done %%");
    expect(got[1]).toBe("\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nnew\n<!-- SECTION:DESCRIPTION:END -->\nnotes");
  });

  test("list: high first, then ordinal, then number; files that aren't cards left out", () => {
    writeFileSync(join(tasks, "notes.md"), "not a card");
    writeFileSync(join(tasks, ".TASK-1.md.tmp"), "half written");
    lua(`
      cards.set("TASK-8", { priority = "high" })
      cards.set("TASK-7", { ordinal = "1" })
      cards.set("TASK-20", { priority = "low" })`);
    expect(lua(`return vim.tbl_map(function(c) return c.id end, cards.list())`)).toEqual(["TASK-1", "TASK-8", "TASK-7", "TASK-2", "TASK-20"]);
  });

  test("get: a card by its id, any case; none is an error", () => {
    expect(lua(`return cards.get("task-7").title`)).toBe("Seven");
    expect(() => lua(`return cards.get("TASK-99")`)).toThrow("no card TASK-99");
  });

  test("waiting_on: dependencies not done, and ones with no card", () => {
    lua(`cards.set("TASK-2", { status = "done" })`);
    const got = lua(`
      local list = cards.list()
      local c = { status = "ready", dependencies = { "task-2", "TASK-7", "TASK-404" } }
      return { cards.waiting_on(c, list), cards.waiting_on({ status = "done", dependencies = { "TASK-7" } }, list) or vim.NIL,
        cards.waiting_on({ status = "ready", dependencies = { "TASK-2" } }, list) or vim.NIL }`);
    expect(got).toEqual([[{ id: "TASK-7", missing: false }, { id: "TASK-404", missing: true }], null, null]);
  });

  test("a card another writer holds is busy; a lock left by a dead one is broken", () => {
    const lock = join(tasks, ".TASK-7.lock");
    mkdirSync(lock);
    const t = Date.now();
    expect(() => lua(`cards.set("TASK-7", { attention = "x" })`)).toThrow("card TASK-7 is busy; try again");
    expect(Date.now() - t).toBeGreaterThanOrEqual(3000);
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    lua(`cards.set("TASK-7", { attention = "x" })`);
    expect(existsSync(lock)).toBe(false);
    expect(parse(join(tasks, "task-7 - Seven.md"))!.attention).toBe("x");
  }, 15_000);

  test("archive and delete need cloud boards", () => {
    expect(() => lua(`cards.archive("TASK-1")`)).toThrow("archive needs cloud boards");
    expect(() => lua(`cards.delete("TASK-1")`)).toThrow("delete needs cloud boards");
  });
});
