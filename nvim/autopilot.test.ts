// The groomer (corkboard.autopilot's groom and undo_groom) on a real board,
// with a claude on PATH that answers as `claude -p --json-schema` does,
// from a file, and keeps what it was asked.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Card, parse } from "../mcp/cards";
import { sandbox } from "./testing";

setDefaultTimeout(20_000);

const box = sandbox();
afterAll(() => box.cleanup());
const answer = join(box.dir, "answer.json");
const asked = join(box.dir, "asked");
// $CORKBOARD_TEST_DURING runs while it "thinks".
box.stub(
  "claude",
  `cat > "${asked}.stdin"; printf '%s\\n' "$@" > "${asked}.args"; [ -n "$CORKBOARD_TEST_DURING" ] && sh -c "$CORKBOARD_TEST_DURING"; [ -f "${answer}.fail" ] && { echo "rate limited" >&2; exit 1; }; cat "${answer}"; touch "${asked}.done"`,
);

const tasks = () => join(box.board, "tasks");
const card = (id: string): Card => {
  const name = readdirSync(tasks()).find((n) => n.startsWith(`${id.toLowerCase()} - `))!;
  return parse(join(tasks(), name))!;
};
const log = (id: string) => card(id).body.match(/<!-- SECTION:NOTES:BEGIN -->\n([\s\S]*)<!-- SECTION:NOTES:END -->/)?.[1] ?? "";

// groom(), waited out: what it said.
function groom(changes: object[], env: Record<string, string> = {}): string[] {
  writeFileSync(answer, JSON.stringify({ type: "result", is_error: false, structured_output: { changes } }));
  Bun.spawnSync(["rm", "-f", `${asked}.done`]);
  // Until it says something, or a moment after claude answered with
  // nothing to say. Undone in the same Neovim, as :AgentUndoGroom would be.
  return box.lua(
    `local said = {}
    vim.notify = function(m) table.insert(said, m) end
    local autopilot = require("corkboard.autopilot")
    autopilot.groom()
    vim.wait(10000, function() return #said > 0 or vim.uv.fs_stat(input.done) ~= nil end)
    vim.wait(300, function() return #said > 0 end)
    if input.undo then said = {} autopilot.undo_groom() end
    return said`,
    { undo: env.UNDO === "1", done: `${asked}.done` },
    { env },
  );
}

const change = (id: string, c: object = {}) => ({ id, priority: "", dependencies: null, description: "", ready: null, duplicate_of: "", question: "", reason: "", ...c });

beforeEach(() => {
  box.lua(`
    local cards = require("corkboard.cards")
    for _, name in ipairs(vim.fn.readdir(cards.tasks_dir())) do os.remove(vim.fs.joinpath(cards.tasks_dir(), name)) end
    cards.create("Write the parser", "backlog", "")
    cards.create("Use the parser", "backlog", "It reads files.")
    cards.create("Write the parser again", "backlog", "")
    cards.create("Taken", "ready", "")
    cards.set("TASK-4", { agent_state = "working" })
    cards.create("Vague", "ready", "")
    cards.create("Doing", "doing", "")`);
});

describe("groom", () => {
  test("reads the open cards and applies what clearly helps, each change logged on its card", () => {
    const said = groom([
      change("task-1", { priority: "high", description: "Parse it.\n\nDone when:\n- it parses", ready: true, reason: "blocks TASK-2" }),
      // Itself, a card that isn't there and one that would make a cycle are dropped.
      change("TASK-2", { dependencies: ["TASK-1", "TASK-2", "TASK-404"], description: "Not this: it has one." }),
      change("TASK-1", { dependencies: ["TASK-2"] }),
      change("TASK-3", { duplicate_of: "TASK-1", reason: "same work" }),
      change("TASK-5", { ready: false }),
    ]);
    expect(said).toEqual(["corkboard: the groomer changed TASK-1, TASK-2, TASK-3, TASK-5"]);
    expect(card("TASK-1")).toMatchObject({ priority: "high", status: "ready" });
    expect(card("TASK-1").body).toContain("<!-- SECTION:DESCRIPTION:BEGIN -->\nParse it.\n\nDone when:\n- it parses\n<!-- SECTION:DESCRIPTION:END -->");
    expect(card("TASK-1").dependencies).toEqual([]);
    expect(log("TASK-1")).toMatch(/groomer: priority high; description written; ready — blocks TASK-2\n.*groomer: TASK-3 was a duplicate of this card\n$/);
    expect(card("TASK-2").dependencies).toEqual(["TASK-1"]);
    expect(card("TASK-2").body).toContain("It reads files.");
    expect(log("TASK-2")).toMatch(/groomer: waits on TASK-1\n$/);
    expect(card("TASK-3").status).toBe("done");
    expect(log("TASK-3")).toMatch(/groomer: duplicate of TASK-1 — same work\n$/);
    expect(card("TASK-5").status).toBe("backlog");
  });

  test("tells claude the open cards and only those, with the schema", () => {
    groom([]);
    const stdin = readFileSync(`${asked}.stdin`, "utf8");
    expect(stdin).toStartWith("# The board's open cards\n\n## TASK-1 [backlog, medium priority]\nWrite the parser\n");
    expect(stdin).toContain("## TASK-4 [ready, medium priority, agent working]\nTaken");
    expect(stdin).toContain("## TASK-2 [backlog, medium priority]\nUse the parser\nIt reads files.");
    const args = readFileSync(`${asked}.args`, "utf8").split("\n");
    expect(args.slice(0, 4)).toEqual(["-p", "--model", "sonnet", "--tools"]);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]).required).toEqual(["changes"]);
  });

  test("leaves alone cards an agent is on or that are under way, and asks only of backlog cards", () => {
    const said = groom([
      change("TASK-4", { priority: "low", ready: false }),
      change("TASK-6", { priority: "low" }),
      change("TASK-1", { question: "Which format?" }),
      change("TASK-5", { question: "What is it?" }),
    ]);
    expect(said).toEqual(["corkboard: the groomer changed TASK-1"]);
    expect(card("TASK-4").priority).toBeUndefined();
    expect(card("TASK-6").priority).toBeUndefined();
    expect(card("TASK-1").attention).toBe("Which format?");
    expect(card("TASK-5").attention).toBeUndefined();
  });

  test("a board that changed while it thought isn't groomed", () => {
    const file = join(tasks(), readdirSync(tasks()).find((n) => n.startsWith("task-1 - "))!);
    const said = groom([change("TASK-1", { priority: "high" })], { CORKBOARD_TEST_DURING: `sed -i 's/^title: .*/title: Renamed/' '${file}'` });
    expect(said).toEqual([]);
    expect(card("TASK-1").title).toBe("Renamed");
    expect(card("TASK-1").priority).toBeUndefined();
  });

  test("says when claude fails", () => {
    writeFileSync(`${answer}.fail`, "");
    try {
      expect(groom([])).toEqual(["corkboard: the groomer failed: rate limited"]);
    } finally {
      Bun.spawnSync(["rm", `${answer}.fail`]);
    }
  });
});

describe("undo_groom", () => {
  test("puts the last run's cards back as they were, and says so", () => {
    const before = card("TASK-2").body;
    const said = groom(
      [
        change("TASK-1", { priority: "low", description: "Parse it.", ready: true }),
        change("TASK-2", { dependencies: ["TASK-1"] }),
        change("TASK-3", { duplicate_of: "TASK-1" }),
        change("TASK-5", { ready: false }),
      ],
      { UNDO: "1" },
    );
    expect(said).toEqual(["corkboard: put back TASK-1, TASK-2, TASK-3, TASK-5"]);
    expect(card("TASK-1")).toMatchObject({ status: "backlog" });
    expect(card("TASK-1").priority).toBeUndefined();
    expect(card("TASK-1").body).toContain("<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->");
    expect(card("TASK-2").dependencies).toEqual([]);
    expect(card("TASK-2").body).toContain(before.split("<!-- SECTION:NOTES")[0]);
    expect(card("TASK-3").status).toBe("backlog");
    expect(card("TASK-5").status).toBe("ready");
    for (const id of ["TASK-1", "TASK-2", "TASK-3", "TASK-5"]) expect(log(id)).toMatch(/user: undid the groomer's changes\n$/);
  });

  test("with nothing to undo, says so", () => {
    expect(box.lua(`local said vim.notify = function(m) said = m end require("corkboard.autopilot").undo_groom() return said`)).toBe("corkboard: nothing to undo");
  });
});
