// The phone's answers to an AskUserQuestion as the keys Claude Code's dialog
// takes (corkboard/away.lua's answer_keys), in a real Neovim. Each list is
// what drove Claude Code 2.1.305's dialog to the answers in a terminal.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LUA = join(import.meta.dir, "lua");
const SCRIPT = join(mkdtempSync(join(tmpdir(), "corkboard-away-")), "keys.lua");
writeFileSync(
  SCRIPT,
  `
    package.path = ${JSON.stringify(LUA + "/?.lua;" + LUA + "/?/init.lua;")} .. package.path
    local input = vim.json.decode(io.read("*a"))
    local keys, why = require("corkboard.away").answer_keys(input.questions, input.answers)
    io.write(vim.json.encode({ keys = keys, why = why }))`,
);

function keys(questions: unknown, answers: unknown): { keys?: string[]; why?: string } {
  const r = Bun.spawnSync(["nvim", "--headless", "--clean", "-l", SCRIPT], { stdin: Buffer.from(JSON.stringify({ questions, answers })) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const opts = (...labels: string[]) => labels.map((label) => ({ label, description: label }));
const COLOR = { question: "Which color?", header: "Color", multiSelect: false, options: opts("Red", "Blue", "Green") };
const TOPPINGS = { question: "Which toppings?", header: "Toppings", multiSelect: true, options: opts("Cheese", "Ham", "Olives") };
const SIZE = { question: "Which size?", header: "Size", multiSelect: false, options: opts("Small", "Large") };

test("one question, one choice: its number, and no review", () => {
  expect(keys([COLOR], [{ picks: [1] }]).keys).toEqual(["2"]);
});

test("one question, its own words: the row after the options", () => {
  expect(keys([COLOR], [{ picks: [], other: "Purple\nish " }]).keys).toEqual(["4", "Purple ish", ENTER]);
});

test("several choices: ticked, down to Next, then the review", () => {
  expect(keys([TOPPINGS], [{ picks: [0, 2] }]).keys).toEqual(["1", "3", DOWN, DOWN, DOWN, DOWN, ENTER, "1"]);
});

test("several questions, with words among several choices", () => {
  expect(keys([COLOR, TOPPINGS, SIZE], [{ picks: [], other: "Purple" }, { picks: [0, 2], other: "Bacon 2x" }, { picks: [1] }]).keys).toEqual([
    "4", "Purple", ENTER,
    "1", "3", "4", DOWN, DOWN, DOWN, "Bacon 2x", DOWN, ENTER,
    "2",
    "1",
  ]);
});

test("answers that don't fit", () => {
  expect(keys([COLOR], [{ picks: [0, 1] }]).why).toContain("pick one");
  expect(keys([COLOR], [{ picks: [3] }]).why).toBe("no such option");
  expect(keys([COLOR, SIZE], [{ picks: [0] }]).why).toBe("answer each question");
  expect(keys(null, [{ picks: [0] }]).why).toBe("it isn't asking");
});
